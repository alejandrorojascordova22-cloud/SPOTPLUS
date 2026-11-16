"""SpotPlus - Analista. Escanea la watchlist al cerrar cada vela y avisa por Telegram.
Por defecto solo avisa. Abre operaciones solo si config_estrategia.json tiene ejecucion.activa = true.

Uso (desde la carpeta raiz del proyecto, con el venv activado):
    python -m backend.analista.escaner --listar XAU     # ver como se llama un simbolo en tu broker
    python -m backend.analista.escaner --una-vez        # un escaneo y sale (para probar)
    python -m backend.analista.escaner --una-vez --sin-telegram
    python -m backend.analista.escaner                  # ciclo continuo
"""
import argparse
import html
import json
import os
import sys
import time
from datetime import datetime, timedelta

from backend.conexion import conexion_mt5 as c
from backend.estrategia.estrategia import analizar, cargar_config, formato_aviso, tfs_de_lentes
from backend.estrategia.riesgo import dimensionar
from backend.notificaciones.telegram_bot import enviar_mensaje
from backend.datos import ruta_archivo

AQUI = os.path.dirname(os.path.abspath(__file__))
RUTA_WATCH = os.path.join(AQUI, "watchlist.json")
RUTA_AVISOS = str(
    ruta_archivo(
        "analista/avisos_enviados.json",
        os.path.join(AQUI, "avisos_enviados.json"),
    )
)
# Misma config de Telegram que usa el servidor (antes habia una copia duplicada).
RUTA_TG = str(ruta_archivo("telegram_config.json"))


def _json(ruta, defecto):
    try:
        with open(ruta, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return defecto


def _watch():
    """watchlist.json + ajustes del estilo activo (intervalo, cooldown, gatillo). "gatillo.activo" solo se
    enciende desde la watchlist: el estilo nunca lo prende por su cuenta."""
    w = _json(RUTA_WATCH, {})
    try:
        extra = (cargar_config().get("_estilo") or {}).get("escaner") or {}
    except Exception:
        extra = {}
    for k, v in extra.items():
        if k == "gatillo":
            w["gatillo"] = {**(w.get("gatillo") or {}), **{kk: vv for kk, vv in v.items() if kk != "activo"}}
        else:
            w[k] = v
    return w


def temporalidades_necesarias(cfg):
    ct = cfg["temporalidades"]
    if ct["modo"] == "manual":
        out = list(ct["seleccion"])
    else:
        out = []
        for lista in ct["roles"].values():
            out += [t for t in lista if t not in out]
    return out + [t for t in tfs_de_lentes(cfg) if t not in out]     # los lentes necesitan sus marcos


def info_simbolo(simbolo):
    """valor por 1.0 de precio por lote, paso/min/max de lote (para calcular el lote sugerido)."""
    with c.bloqueo_mt5():
        i = c.mt5.symbol_info(simbolo)
    if i is None or not i.trade_tick_size:
        return None
    return dict(valor=i.trade_tick_value / i.trade_tick_size, paso=i.volume_step,
                minimo=i.volume_min, maximo=i.volume_max)


def modo_activo(base, sim, w, cfg):
    """'auto' = avisa y opera | 'avisar' = solo avisa. (Fuera de la watchlist = ni avisa ni opera.)"""
    permitidos = set(simbolos_auto(w, cfg))
    return "auto" if base.upper() in permitidos or sim.upper() in permitidos else "avisar"


def simbolos_auto(w, cfg):
    """Activos de la watchlist autorizados para apertura automática ahora."""
    ej = cfg.get("ejecucion") or {}
    if not ej.get("activa"):
        return []
    simbolos = [str(s).strip() for s in w.get("simbolos", []) if str(s).strip()]
    if ej.get("todas_las_proyecciones"):
        return [s.upper() for s in simbolos]
    operar = w.get("operar")
    if operar is None:
        operar = str(ej.get("simbolos", "XAUUSD")).split(",")
    permitidos = {s.strip().upper() for s in operar if s.strip()}
    sufijo = str(w.get("sufijo", ""))
    return [
        base.upper()
        for base in simbolos
        if base.upper() in permitidos or (base + sufijo).upper() in permitidos
    ]


def resumen_activos(w, cfg):
    seguidos = [str(s).strip() for s in w.get("simbolos", []) if str(s).strip()]
    marcados = w.get("operar")
    if marcados is None:
        marcados = str((cfg.get("ejecucion") or {}).get("simbolos", "XAUUSD")).split(",")
    marcados = [str(s).strip() for s in marcados if str(s).strip()]
    permitidos = simbolos_auto(w, cfg)
    texto_seguidos = ", ".join(seguidos) if seguidos else "ninguno"
    texto_marcados = ", ".join(marcados) if marcados else "ninguno"
    texto_auto = ", ".join(permitidos) if permitidos else "apagada"
    return (
        "\nSeguimiento: %s.\n"
        "Marcados para operar: %s.\n"
        "Apertura automática: %s (solo con señal confirmada; este aviso no confirma que la orden se abrió)."
        % (texto_seguidos, texto_marcados, texto_auto)
    )


def ya_avisado(avisos, e, cooldown_h):
    z = e["zona_rango"]
    clave = "%s|%s|%s|%s|%s-%s" % (e["simbolo"], e["direccion"], e["zona"], e["zona_tf"], round(z[0]), round(z[1]))
    prev = avisos.get(clave)
    ahora = datetime.now()
    if prev:
        hace = ahora - datetime.fromisoformat(prev["ts"])
        subio = prev["estado"] != "confirmada" and e["estado"] == "confirmada"   # dentro -> confirmada si avisa
        if hace < timedelta(hours=cooldown_h) and not subio:
            return clave, True
    return clave, False


def ejecutar_escenario(e, sim, lotes, cfg, cuenta, w=None, manual=False):
    """Ejecuta una señal autorizada por el paso 9 o una entrada manual confirmada."""
    ej = cfg.get("ejecucion") or {}
    if (not ej.get("activa") and not manual) or e["estado"] != "confirmada":
        return []
    # Una entrada manual (la eliges tu en Proyecciones) o "operar todas las proyecciones" ignoran la marca Operar.
    if not manual and not ej.get("todas_las_proyecciones"):
        permitidos = set(simbolos_auto(w or {}, cfg))
        suf = (w or {}).get("sufijo", "")
        base = sim[:-len(suf)] if suf and sim.endswith(suf) else sim
        if base.upper() not in permitidos and sim.upper() not in permitidos:
            return ["%s en seguimiento (no marcado para operar): solo aviso." % sim]
    if ej.get("solo_cuenta_demo", True) and cuenta.get("es_real"):
        return ["Cuenta REAL: no abro operaciones (ejecucion.solo_cuenta_demo = true)."]
    if not lotes:
        return ["Sin lote calculado: no abro operaciones."]
    maximo = int(ej.get("max_posiciones_por_simbolo", 1))
    if maximo > 0 and len(c.obtener_posiciones_abiertas(sim)) >= maximo:
        return ["Ya hay %d posicion(es) abierta(s) en %s: no abro otra." % (maximo, sim)]
    tipo = "compra" if e["direccion"] == "alcista" else "venta"
    precio = c.obtener_precio_actual(sim)
    if not precio:
        return ["Sin precio actual: no abro operaciones."]
    ref = precio["ask"] if tipo == "compra" else precio["bid"]
    sl = e["sl"]
    if (tipo == "compra" and sl >= ref) or (tipo == "venta" and sl <= ref):
        return ["El SL (%s) quedo del lado equivocado del precio (%s): no abro." % (sl, ref)]
    out = []
    for o in e["operaciones"]:
        if (tipo == "compra" and o["tp"] <= ref) or (tipo == "venta" and o["tp"] >= ref):
            out.append("%s: TP %.2f ya no es alcanzable desde %s, se omite." % (o["nombre"], o["tp"], ref))
            continue
        lote = next((l["lote"] for l in lotes if l["operacion"] == o["nombre"]), 0)
        if not lote:
            out.append("%s: lote 0 (riesgo muy chico), se omite." % o["nombre"])
            continue
        r = c.enviar_orden_manual(tipo, lote, sim, sl=sl, tp=o["tp"],
                                  spread_maximo_puntos=ej.get("spread_maximo_puntos", 0),
                                  comment=("SpotPlus " + o["nombre"])[:30])
        if r.get("ok"):
            out.append("%s %s %.2f lotes ABIERTA (SL %s, TP %.2f)" % (tipo.upper(), o["nombre"], lote, sl, o["tp"]))
        else:
            out.append("%s: orden RECHAZADA: %s" % (o["nombre"], r.get("error")))
    return out


RUTA_ESTADO = str(
    ruta_archivo(
        "analista/escaner_estado.json",
        os.path.join(AQUI, "escaner_estado.json"),
    )
)


def escribir_estado(w, cfg, sin_datos, errores, n_avisos, proyecciones=None):
    """Latido del escaner: la web lo lee para saber si esta corriendo y que activos fallan."""
    try:
        datos = dict(
            ts=datetime.now().isoformat(timespec="seconds"),
            intervalo_min=w.get("intervalo_min", 5),
            activos=len(w.get("simbolos", [])),
            sin_datos=sin_datos,
            errores=errores,
            avisos_nuevos=n_avisos,
            ejecucion_activa=bool((cfg.get("ejecucion") or {}).get("activa")),
            proyecciones=proyecciones or {},
        )
        tmp = RUTA_ESTADO + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(datos, f, ensure_ascii=False)
        os.replace(tmp, RUTA_ESTADO)
    except Exception as ex:
        print("No pude guardar el estado del escaner:", ex)


# ---------------------------------------------------------------------------
# Gatillo en vivo (apagado por defecto). Se activa en watchlist.json:
#   "gatillo": {"activo": true, "revisar_seg": 2, "reescaneo_seg": 60, "min_seg_entre_escaneos": 5}
# El escaner normal marca las zonas "armadas" (precio dentro/cerca de una zona esperando
# confirmacion). Entre vela y vela, este vigilante mira solo el precio (barato) y reescanea
# UNICAMENTE el activo armado cuando el precio sale de la zona o pasa "reescaneo_seg".
# Las reglas de decision son las mismas: reusa procesar_simbolo().
# ---------------------------------------------------------------------------
ARMADAS = {}   # base -> dict(zonas=[(bajo, alto)], dentro=bool|None, ultimo=epoch)


def _armar(base, esc):
    zonas = [tuple(e["zona_rango"]) for e in esc if e["estado"] in ("dentro", "esperando")]
    if zonas:
        ARMADAS[base] = dict(zonas=zonas, dentro=None, ultimo=time.time(),
                             bucket=int(time.time() // (60 * _min_micro_actual())))
    else:
        ARMADAS.pop(base, None)


def _contexto(sin_telegram):
    cfg = cargar_config()                      # se relee cada vez: cambios del JSON aplican sin reiniciar
    w = _watch()
    cuenta = c.obtener_info_cuenta() or {}
    return dict(cfg=cfg, w=w, avisos=_json(RUTA_AVISOS, {}), tg=_json(RUTA_TG, {}),
                tfs=temporalidades_necesarias(cfg), cuenta=cuenta, balance=cuenta.get("balance"),
                sin_telegram=sin_telegram)


def _guardar_avisos(avisos):
    with open(RUTA_AVISOS, "w", encoding="utf-8") as f:
        json.dump(avisos, f, indent=1, ensure_ascii=False)


def procesar_simbolo(base, ctx):
    """Analiza UN activo, avisa y (si toca) opera. Devuelve (proyeccion, n_avisos, sin_datos, error)."""
    cfg, w, avisos, tg = ctx["cfg"], ctx["w"], ctx["avisos"], ctx["tg"]
    sin_telegram = ctx["sin_telegram"]
    sim = base if base.endswith(w.get("sufijo", "")) else base + w.get("sufijo", "")
    proy = {"simbolo": base, "mt5": sim, "escenarios": []}
    try:
        velas = c.obtener_velas_varias_temporalidades(sim, ctx["tfs"], w["velas_por_tf"])
        velas = {tf: df.iloc[:-1].reset_index(drop=True) for tf, df in velas.items()}   # solo velas cerradas
        if not velas:
            print("[%s] sin datos (revisa el nombre del simbolo con --listar)" % sim)
            proy["error"] = "sin_datos"
            ARMADAS.pop(base, None)
            return proy, 0, True, None
        esc = analizar(sim, velas, cfg)
    except Exception as ex:
        print("[%s] error: %s" % (sim, ex))
        proy["error"] = str(ex)[:120]
        return proy, 0, False, proy["error"]
    _armar(base, esc)
    n_avisos = 0
    for e in esc:
        clave, repetido = ya_avisado(avisos, e, w["cooldown_horas"])
        lotes = None
        si = info_simbolo(sim)
        if si and ctx["balance"]:
            lotes = dimensionar(cfg["riesgo"], ctx["balance"], e["entrada"], e["sl"], e["operaciones"],
                                si["valor"], si["paso"], si["minimo"], si["maximo"])
        proyeccion = {k: v for k, v in e.items() if not k.startswith("_")}
        proyeccion.update(clave=clave, lotes=lotes or [],
                          ejecutada=bool((avisos.get(clave) or {}).get("ejecutada")))
        proy["escenarios"].append(proyeccion)
        if repetido:
            continue
        modo = modo_activo(base, sim, w, cfg)
        texto = formato_aviso(e, lotes, modo) + resumen_activos(w, cfg)
        print("\n" + texto)
        if not sin_telegram and tg.get("telegram_activo"):
            r = enviar_mensaje(tg.get("telegram_bot_token"), tg.get("telegram_chat_id"), html.escape(texto))
            if not r["ok"]:
                print("Telegram fallo:", r["error"])
        abierta = False
        for linea in (ejecutar_escenario(e, sim, lotes, cfg, ctx["cuenta"], w) if modo == "auto" else []):
            print("[EJECUCION] " + linea)
            abierta = abierta or " ABIERTA " in linea
            if not sin_telegram and tg.get("telegram_activo"):
                enviar_mensaje(
                    tg.get("telegram_bot_token"),
                    tg.get("telegram_chat_id"),
                    html.escape("[RESULTADO DE EJECUCIÓN · %s] %s" % (sim, linea)),
                )
        avisos[clave] = dict(estado=e["estado"], ts=datetime.now().isoformat(timespec="seconds"))
        if abierta:
            avisos[clave]["ejecutada"] = True
            proyeccion["ejecutada"] = True
        n_avisos += 1
    return proy, n_avisos, False, None


def escanear(sin_telegram=False):
    ctx = _contexto(sin_telegram)
    w, cfg = ctx["w"], ctx["cfg"]
    n_avisos = 0
    sin_datos, errores = [], {}
    proyecciones = {}
    for base in w["simbolos"]:
        proy, n, sd, err = procesar_simbolo(base, ctx)
        proyecciones[base] = proy
        n_avisos += n
        if sd:
            sin_datos.append(proy["mt5"])
        if err:
            errores[proy["mt5"]] = err
    _guardar_avisos(ctx["avisos"])
    escribir_estado(w, cfg, sin_datos, errores, n_avisos, proyecciones)
    print("[%s] escaneo listo: %d activos, %d avisos nuevos" % (datetime.now().strftime("%H:%M:%S"), len(w["simbolos"]), n_avisos))


def _actualizar_estado_simbolo(ctx, base, proy, n_avisos):
    """El gatillo solo refresca su activo dentro del estado que ya publico el escaner."""
    est = _json(RUTA_ESTADO, {})
    est.setdefault("proyecciones", {})[base] = proy
    est["ts"] = datetime.now().isoformat(timespec="seconds")
    est["avisos_nuevos"] = int(est.get("avisos_nuevos", 0)) + n_avisos
    try:
        tmp = RUTA_ESTADO + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(est, f, ensure_ascii=False)
        os.replace(tmp, RUTA_ESTADO)
    except Exception as ex:
        print("No pude guardar el estado del gatillo:", ex)


TF_MIN = {"M1": 1, "M3": 3, "M5": 5, "M15": 15, "M30": 30, "H1": 60, "H2": 120, "H4": 240}
PRECIOS = {}        # base -> [(epoch, mid)] ventana corta para detectar saltos de precio (noticias)
ULTIMO_SALTO = {}   # base -> epoch del ultimo reescaneo por salto


def _min_micro(cfg):
    """Minutos de la temporalidad micro mas rapida que confirma: cuando cierra una vela de esa, se reescanea."""
    cc, roles = cfg["confirmacion"], cfg["temporalidades"]["roles"]
    tfs = cc.get("micro_manual") if cc.get("micro_tfs") == "manual" else roles.get("micro", [])
    mins = [TF_MIN[t] for t in (tfs or []) if t in TF_MIN]
    return min(mins) if mins else 5


def _min_micro_actual():
    try:
        return _min_micro(cargar_config())
    except Exception:
        return 5


def _reescanear(base, motivo, sin_telegram):
    print("[GATILLO] %s: %s" % (base, motivo))
    ctx = _contexto(sin_telegram)
    proy, n, _sd, _err = procesar_simbolo(base, ctx)
    if n:
        _guardar_avisos(ctx["avisos"])
    _actualizar_estado_simbolo(ctx, base, proy, n)
    if base in ARMADAS:
        ARMADAS[base]["ultimo"] = time.time()
        ARMADAS[base]["bucket"] = int(time.time() // (60 * _min_micro(ctx["cfg"])))


def vigilar_saltos(g, w, sin_telegram, ya):
    """Mira el precio de TODOS los activos de la watchlist; si salta (noticia) reescanea ese activo ya."""
    pct = float(g.get("salto_pct", 0) or 0)
    if pct <= 0:
        return
    ventana = float(g.get("ventana_salto_seg", 10))
    espera = float(g.get("min_seg_entre_saltos", 30))
    ahora = time.time()
    for base in w.get("simbolos", []):
        sim = base if base.endswith(w.get("sufijo", "")) else base + w.get("sufijo", "")
        p = c.obtener_precio_actual(sim)
        if not p:
            continue
        mid = (p["bid"] + p["ask"]) / 2
        hist = [x for x in PRECIOS.get(base, []) if ahora - x[0] <= ventana] + [(ahora, mid)]
        PRECIOS[base] = hist
        ref = hist[0][1]
        if base in ya or not ref:
            continue
        mov = abs(mid - ref) / ref * 100
        if mov >= pct and ahora - ULTIMO_SALTO.get(base, 0) >= espera:
            ULTIMO_SALTO[base] = ahora
            PRECIOS[base] = [(ahora, mid)]
            _reescanear(base, "salto de precio %.2f%% en %ds (noticia?)" % (mov, ventana), sin_telegram)
            ya.add(base)


def vigilar_gatillo(sin_telegram=False):
    """Una pasada del vigilante en vivo (barata: solo ticks). Reescanea SOLO lo que lo pide:
    cierre de vela micro, precio que entra/sale de una zona, revision periodica o salto de precio."""
    w = _watch()
    g = w.get("gatillo") or {}
    if not g.get("activo"):
        return
    try:
        m = _min_micro(cargar_config())
    except Exception:
        m = 5
    ahora = time.time()
    hechos = set()
    for base in list(ARMADAS):
        a = ARMADAS.get(base)
        if not a:
            continue
        sim = base if base.endswith(w.get("sufijo", "")) else base + w.get("sufijo", "")
        p = c.obtener_precio_actual(sim)
        if not p:
            continue
        mid = (p["bid"] + p["ask"]) / 2
        dentro = any(b <= mid <= alto for b, alto in a["zonas"])
        salio = a["dentro"] is True and not dentro
        entro = a["dentro"] is False and dentro and g.get("al_entrar_zona", True)
        a["dentro"] = dentro
        bucket = int(ahora // (60 * m))
        vela = (g.get("al_cerrar_vela_micro", True) and bucket > a.get("bucket", bucket)
                and (ahora % (60 * m)) >= float(g.get("retraso_cierre_seg", 2)))
        toca_tiempo = ahora - a["ultimo"] >= g.get("reescaneo_seg", 60)
        if ahora - a["ultimo"] < g.get("min_seg_entre_escaneos", 5) or not (salio or entro or vela or toca_tiempo):
            continue
        motivo = ("precio salio de la zona" if salio else "precio entro a la zona" if entro
                  else "cerro una vela micro" if vela else "revision periodica")
        _reescanear(base, motivo, sin_telegram)
        hechos.add(base)
    vigilar_saltos(g, w, sin_telegram, hechos)


def esperar_siguiente_vela(intervalo_min, sin_telegram=False):
    ahora = datetime.now()
    mins = intervalo_min - (ahora.minute % intervalo_min)
    prox = (ahora + timedelta(minutes=mins)).replace(second=5, microsecond=0)   # 5 s despues de cerrar la vela
    while True:
        falta = (prox - datetime.now()).total_seconds()
        if falta <= 0:
            return
        g = _watch().get("gatillo") or {}
        if not g.get("activo"):
            time.sleep(max(falta, 1))                  # sin gatillo: espera normal, cero carga extra
            return
        time.sleep(min(max(float(g.get("revisar_seg", 2)), 0.5), max(falta, 0.5)))
        if (prox - datetime.now()).total_seconds() > 8:   # en los ultimos segundos manda el escaneo normal
            try:
                vigilar_gatillo(sin_telegram)
            except Exception as ex:
                print("[GATILLO] error: %s" % ex)


def _configurar_salida_consola():
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure:
        reconfigure(errors="backslashreplace")


def main():
    _configurar_salida_consola()
    p = argparse.ArgumentParser()
    p.add_argument("--una-vez", action="store_true")
    p.add_argument("--sin-telegram", action="store_true")
    p.add_argument("--listar", metavar="TEXTO", help="lista simbolos del broker que contengan TEXTO")
    a = p.parse_args()
    if not c.conectar():
        raise SystemExit("No se pudo conectar a MT5 (revisa el .env y que la terminal este abierta)")
    if a.listar:
        print(c.obtener_simbolos_disponibles(a.listar))
        return
    escanear(a.sin_telegram)
    while not a.una_vez:
        esperar_siguiente_vela(_watch().get("intervalo_min", 5), a.sin_telegram)   # se relee: un cambio de estilo aplica sin reiniciar
        escanear(a.sin_telegram)


if __name__ == "__main__":
    main()