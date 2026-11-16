"""Guardia de riesgo de SpotPlus: ultimo filtro ANTES de enviar una orden de ENTRADA.

Se llama desde conexion_mt5.enviar_orden_manual (el unico punto por donde pasan el
escaner, la estrategia del servidor y las ordenes manuales), ya dentro del candado de
MT5. Asi las reglas valen igual para todos los procesos.

Controles:
  1. Kill switch: apaga TODAS las entradas (tambien las manuales) hasta que lo reanudes.
  2. Perdida diaria maxima (% del balance de inicio del dia y/o monto fijo). Al
     alcanzarla se bloquea el resto del dia (dia del servidor del broker).
  3. Maximo de operaciones abiertas (posiciones + pendientes) y de entradas por dia.
  4. Duplicados: misma direccion y mismo SL/TP en el mismo simbolo, o la misma
     orden repetida en pocos segundos.
  5. Exigir SL y lote maximo por orden.

NO bloquea cierres, break even ni cambios de SL/TP: solo entradas nuevas.
Si la guardia no puede leer su archivo o MT5, bloquea (falla cerrado).

Configuracion y estado: backend/datos/guardia_riesgo.json (se lee en cada orden,
asi que los cambios aplican sin reiniciar). Bloqueos: guardia_riesgo.log.jsonl.

Uso por terminal (desde la raiz del proyecto):
  python -m backend.operaciones.guardia_riesgo estado
  python -m backend.operaciones.guardia_riesgo parar "motivo opcional"
  python -m backend.operaciones.guardia_riesgo reanudar [--incluir-dia]
  python -m backend.operaciones.guardia_riesgo poner perdida_diaria_max_pct 2
"""
import html
import json
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

from ..conexion.mt5_compat import mt5, MT5_AVAILABLE
from ..datos import ruta_archivo

RUTA = ruta_archivo("guardia_riesgo.json")
RUTA_LOG = ruta_archivo("guardia_riesgo.log.jsonl")
RUTA_TG = ruta_archivo("telegram_config.json")

CONFIG_DEFECTO = {
    "activo": True,
    "perdida_diaria_max_pct": 3.0,       # % del balance de inicio del dia (0 = sin limite)
    "perdida_diaria_max_monto": 0.0,     # monto fijo en la moneda de la cuenta (0 = sin limite)
    "max_operaciones_abiertas": 6,       # posiciones + pendientes en toda la cuenta (0 = sin limite)
    "max_operaciones_por_dia": 20,       # entradas abiertas hoy (0 = sin limite)
    "bloquear_duplicados": True,
    "ventana_duplicado_seg": 30,
    "exigir_sl": True,
    "lote_maximo": 0.0,                  # por orden (0 = sin limite)
    "aplicar_a_manuales": False,         # False: las manuales solo respetan el kill switch
    "avisar_telegram": True,
}

ESTADO_DEFECTO = {
    "kill_switch": False,
    "motivo": "",
    "desde": None,
    "bloqueo_diario": {"dia": None, "motivo": "", "ts": None},
    "ultimo_aviso": {},
}

AVISO_CADA_SEG = 600  # no repetir el mismo aviso de Telegram en menos de 10 min
_lock = threading.Lock()


# ---------------------------------------------------------------- archivo
def cargar():
    """Devuelve (config, estado, error). error != None si el archivo existe pero no se puede leer."""
    config = dict(CONFIG_DEFECTO)
    estado = json.loads(json.dumps(ESTADO_DEFECTO))
    if not os.path.exists(RUTA):
        return config, estado, None
    try:
        with open(RUTA, encoding="utf-8") as f:
            datos = json.load(f)
        if not isinstance(datos, dict):
            raise ValueError("el archivo no es un objeto JSON")
        for clave, defecto in CONFIG_DEFECTO.items():
            if clave in (datos.get("config") or {}):
                valor = datos["config"][clave]
                config[clave] = bool(valor) if isinstance(defecto, bool) else float(valor) \
                    if isinstance(defecto, float) else int(valor)
        est = datos.get("estado") or {}
        estado["kill_switch"] = bool(est.get("kill_switch", False))
        estado["motivo"] = str(est.get("motivo") or "")
        estado["desde"] = est.get("desde")
        bd = est.get("bloqueo_diario") or {}
        estado["bloqueo_diario"] = {"dia": bd.get("dia"), "motivo": bd.get("motivo", ""), "ts": bd.get("ts")}
        estado["ultimo_aviso"] = dict(est.get("ultimo_aviso") or {})
        return config, estado, None
    except Exception as ex:
        return config, estado, "%s: %s" % (type(ex).__name__, ex)


def _guardar(config, estado):
    tmp = str(RUTA) + ".tmp"
    with _lock:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"config": config, "estado": estado}, f, ensure_ascii=False, indent=2)
        os.replace(tmp, RUTA)


def _log(evento, **detalle):
    try:
        linea = {"ts": datetime.now().isoformat(timespec="seconds"), "evento": evento, **detalle}
        with _lock:
            with open(RUTA_LOG, "a", encoding="utf-8") as f:
                f.write(json.dumps(linea, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _avisar(texto):
    """Telegram en un hilo aparte: nunca debe retrasar una orden ni dejar el candado de MT5 colgado."""
    def _hilo():
        try:
            with open(RUTA_TG, encoding="utf-8") as f:
                tg = json.load(f)
            if not tg.get("telegram_activo"):
                return
            from ..notificaciones.telegram_bot import enviar_mensaje
            enviar_mensaje(tg.get("telegram_bot_token"), tg.get("telegram_chat_id"), html.escape(texto))
        except Exception:
            pass
    threading.Thread(target=_hilo, daemon=True).start()


# ------------------------------------------------------------ acciones publicas
def parar(motivo="manual"):
    config, estado, _ = cargar()
    estado["kill_switch"] = True
    estado["motivo"] = motivo or "manual"
    estado["desde"] = datetime.now().isoformat(timespec="seconds")
    _guardar(config, estado)
    _log("kill_switch_on", motivo=estado["motivo"])
    return estado


def reanudar(incluir_dia=False):
    config, estado, _ = cargar()
    estado["kill_switch"] = False
    estado["motivo"] = ""
    estado["desde"] = None
    if incluir_dia:
        estado["bloqueo_diario"] = {"dia": None, "motivo": "", "ts": None}
    _guardar(config, estado)
    _log("kill_switch_off", incluir_dia=bool(incluir_dia))
    return estado


def poner(clave, valor):
    if clave not in CONFIG_DEFECTO:
        raise KeyError("opcion desconocida: %s" % clave)
    config, estado, _ = cargar()
    defecto = CONFIG_DEFECTO[clave]
    if isinstance(defecto, bool):
        config[clave] = str(valor).strip().lower() in ("1", "true", "si", "sí", "on", "yes")
    elif isinstance(defecto, float):
        config[clave] = float(valor)
    else:
        config[clave] = int(float(valor))
    _guardar(config, estado)
    _log("config", clave=clave, valor=config[clave])
    return config


# ----------------------------------------------------------------- bloqueo
def _bloqueo(codigo, mensaje, config=None, estado=None, **detalle):
    _log("bloqueo", codigo=codigo, mensaje=mensaje, **detalle)
    try:
        if config is None or estado is None:
            config, estado, _ = cargar()
        if config.get("avisar_telegram", True):
            ahora = time.time()
            if ahora - float(estado["ultimo_aviso"].get(codigo, 0)) >= AVISO_CADA_SEG:
                estado["ultimo_aviso"][codigo] = ahora
                _guardar(config, estado)
                _avisar("\U0001F6D1 Guardia de riesgo: orden NO enviada\n%s" % mensaje)
    except Exception:
        pass
    return {"ok": False, "error": mensaje, "bloqueada_por": codigo, "guardia": True}


# ---------------------------------------------------------------- consultas MT5
def _es_compra_orden(t):
    return t in (0, 2, 4, 6)   # BUY, BUY_LIMIT, BUY_STOP, BUY_STOP_LIMIT


def _lista(m, resultado, que):
    """positions_get / orders_get / history_deals_get devuelven None en error y () si no hay nada."""
    if resultado is None:
        err = m.last_error() if hasattr(m, "last_error") else None
        if err and err[0] != 1:
            raise RuntimeError("MT5 no pudo leer %s: %s" % (que, err))
        return []
    return list(resultado)


def _ahora_servidor(m, simbolo):
    """Reloj del servidor del broker (el dia de la perdida diaria se corta a su medianoche)."""
    t = 0
    try:
        tick = m.symbol_info_tick(simbolo)
        t = int(getattr(tick, "time", 0) or 0)
    except Exception:
        t = 0
    if not t or abs(t - time.time()) > 15 * 3600:   # tick viejo (mercado cerrado): usa el reloj local
        t = int(time.time())
    return t


def _deals_hoy(m, inicio_dia):
    desde = datetime.now() - timedelta(days=2)
    hasta = datetime.now() + timedelta(days=2)
    deals = _lista(m, m.history_deals_get(desde, hasta), "el historial de hoy")
    return [d for d in deals if int(getattr(d, "time", 0) or 0) >= inicio_dia]


# ------------------------------------------------------------------ revision
def revisar_orden(tipo, volumen, simbolo, sl=0.0, tp=0.0, origen="bot",
                  tipo_orden="mercado", comentario=None, mt5_mod=None):
    """None si la orden puede salir; si no, dict {"ok": False, "error", "bloqueada_por", "guardia"}."""
    try:
        return _revisar(tipo, volumen, simbolo, sl, tp, origen, tipo_orden, comentario, mt5_mod)
    except Exception as ex:
        return _bloqueo("error_guardia",
                        "La guardia de riesgo fallo (%s); por seguridad no se envio la orden." % ex)


def _revisar(tipo, volumen, simbolo, sl, tp, origen, tipo_orden, comentario, mt5_mod):
    config, estado, error = cargar()
    if error:
        return _bloqueo("config_ilegible",
                        "No pude leer guardia_riesgo.json (%s). Arreglalo o borralo; no se envio la orden." % error)

    # 1. Kill switch: manda sobre todo lo demas, incluidas las ordenes manuales.
    if estado["kill_switch"]:
        return _bloqueo("kill_switch",
                        "KILL SWITCH activo (%s). No se abren operaciones nuevas hasta que lo reanudes." %
                        (estado["motivo"] or "sin motivo"), config, estado, simbolo=simbolo)

    if not config["activo"]:
        return None
    if origen == "manual" and not config["aplicar_a_manuales"]:
        return None

    m = mt5_mod if mt5_mod is not None else mt5
    if mt5_mod is None and not MT5_AVAILABLE:
        return None   # sin la libreria MT5 no hay nada real que proteger (desarrollo/tests)

    # 2. Sanidad de la orden
    if config["lote_maximo"] > 0 and float(volumen) > config["lote_maximo"]:
        return _bloqueo("lote_maximo",
                        "Lote %.2f supera el maximo permitido por orden (%.2f)." %
                        (float(volumen), config["lote_maximo"]), config, estado, simbolo=simbolo)
    if config["exigir_sl"] and not sl:
        return _bloqueo("sin_sl", "La orden no trae Stop Loss y la guardia lo exige.",
                        config, estado, simbolo=simbolo)

    # 3. Lecturas de MT5 (una sola vez)
    ahora_srv = _ahora_servidor(m, simbolo)
    inicio_dia = ahora_srv - (ahora_srv % 86400)
    dia = datetime.fromtimestamp(inicio_dia, timezone.utc).strftime("%Y-%m-%d")

    if estado["bloqueo_diario"].get("dia") == dia:
        return _bloqueo("perdida_diaria",
                        "Bloqueado por perdida diaria maxima hasta manana: %s" %
                        (estado["bloqueo_diario"].get("motivo") or ""), config, estado, simbolo=simbolo)

    posiciones = _lista(m, m.positions_get(), "las posiciones abiertas")
    pendientes = _lista(m, m.orders_get(), "las ordenes pendientes")
    deals = _deals_hoy(m, inicio_dia)
    cuenta = m.account_info()
    if cuenta is None:
        raise RuntimeError("MT5 no devolvio datos de la cuenta")

    # 4. Perdida diaria (realizada hoy + flotante), sin contar depositos/retiros
    operaciones = [d for d in deals if getattr(d, "type", None) in (0, 1)]
    realizado = sum(float(getattr(d, "profit", 0) or 0) + float(getattr(d, "commission", 0) or 0) +
                    float(getattr(d, "swap", 0) or 0) + float(getattr(d, "fee", 0) or 0) for d in operaciones)
    depositos = sum(float(getattr(d, "profit", 0) or 0) for d in deals if getattr(d, "type", None) == 2)
    flotante = sum(float(getattr(p, "profit", 0) or 0) + float(getattr(p, "swap", 0) or 0) for p in posiciones)
    balance_inicio = float(cuenta.balance) - realizado - depositos
    perdida = -(realizado + flotante)

    limites = []
    if config["perdida_diaria_max_pct"] > 0 and balance_inicio > 0:
        limites.append(balance_inicio * config["perdida_diaria_max_pct"] / 100.0)
    if config["perdida_diaria_max_monto"] > 0:
        limites.append(config["perdida_diaria_max_monto"])
    if limites and perdida >= min(limites):
        motivo = "perdida de hoy %.2f >= limite %.2f (balance de inicio %.2f)" % (perdida, min(limites), balance_inicio)
        estado["bloqueo_diario"] = {"dia": dia, "motivo": motivo,
                                    "ts": datetime.now().isoformat(timespec="seconds")}
        _guardar(config, estado)
        return _bloqueo("perdida_diaria", "PERDIDA DIARIA MAXIMA alcanzada: %s. Sin entradas hasta manana." % motivo,
                        config, estado, simbolo=simbolo, perdida=round(perdida, 2))

    # 5. Maximo de operaciones abiertas y por dia
    abiertas = len(posiciones) + len(pendientes)
    if config["max_operaciones_abiertas"] > 0 and abiertas >= config["max_operaciones_abiertas"]:
        return _bloqueo("max_abiertas",
                        "Ya hay %d operaciones/pendientes abiertas (maximo %d)." %
                        (abiertas, config["max_operaciones_abiertas"]), config, estado, simbolo=simbolo)
    entradas_hoy = sum(1 for d in operaciones if getattr(d, "entry", None) == 0)
    if config["max_operaciones_por_dia"] > 0 and entradas_hoy >= config["max_operaciones_por_dia"]:
        return _bloqueo("max_por_dia",
                        "Ya se abrieron %d entradas hoy (maximo %d)." %
                        (entradas_hoy, config["max_operaciones_por_dia"]), config, estado, simbolo=simbolo)

    # 6. Duplicados
    if config["bloquear_duplicados"]:
        es_compra = tipo == "compra"
        try:
            punto = float(m.symbol_info(simbolo).point) or 1e-5
        except Exception:
            punto = 1e-5
        tol = 2 * punto
        for p in posiciones:
            if getattr(p, "symbol", None) == simbolo and (getattr(p, "type", None) == 0) == es_compra and \
                    abs(float(getattr(p, "sl", 0) or 0) - float(sl or 0)) <= tol and \
                    abs(float(getattr(p, "tp", 0) or 0) - float(tp or 0)) <= tol:
                return _bloqueo("duplicada",
                                "Ya hay una %s abierta en %s con el mismo SL y TP (ticket %s)." %
                                (tipo, simbolo, getattr(p, "ticket", "?")), config, estado, simbolo=simbolo)
        for o in pendientes:
            if getattr(o, "symbol", None) == simbolo and _es_compra_orden(getattr(o, "type", None)) == es_compra and \
                    abs(float(getattr(o, "sl", 0) or 0) - float(sl or 0)) <= tol and \
                    abs(float(getattr(o, "tp", 0) or 0) - float(tp or 0)) <= tol:
                return _bloqueo("duplicada",
                                "Ya hay una orden pendiente %s en %s con el mismo SL y TP (ticket %s)." %
                                (tipo, simbolo, getattr(o, "ticket", "?")), config, estado, simbolo=simbolo)
        ventana = int(config["ventana_duplicado_seg"])
        coment = str(comentario or "orden manual - SpotPlus")[:31]
        for d in operaciones:
            if getattr(d, "entry", None) == 0 and getattr(d, "symbol", None) == simbolo and \
                    (getattr(d, "type", None) == 0) == es_compra and \
                    abs(float(getattr(d, "volume", 0) or 0) - float(volumen)) < 1e-9 and \
                    str(getattr(d, "comment", "") or "")[:31] == coment and \
                    ahora_srv - int(getattr(d, "time", 0) or 0) <= ventana:
                return _bloqueo("duplicada",
                                "La misma orden de %s en %s ya salio hace menos de %d s." %
                                (tipo, simbolo, ventana), config, estado, simbolo=simbolo)
    return None


# ------------------------------------------------------------------ estado
def estado_actual():
    config, estado, error = cargar()
    return {"config": config, "estado": estado, "error": error}


def _imprimir_estado():
    datos = estado_actual()
    if datos["error"]:
        print("ARCHIVO ILEGIBLE (la guardia bloquea todo): %s" % datos["error"])
    est = datos["estado"]
    print("Kill switch :", "ACTIVO (%s, desde %s)" % (est["motivo"], est["desde"]) if est["kill_switch"] else "apagado")
    bd = est["bloqueo_diario"]
    print("Bloqueo dia :", "%s -> %s" % (bd["dia"], bd["motivo"]) if bd.get("dia") else "ninguno")
    print("Config      :")
    for k, v in datos["config"].items():
        print("   %-28s %s" % (k, v))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    comando = argv[0] if argv else "estado"
    if comando == "estado":
        _imprimir_estado()
    elif comando == "parar":
        parar(" ".join(argv[1:]) or "manual")
        print("Kill switch ACTIVADO. No se abren operaciones nuevas.")
    elif comando == "reanudar":
        reanudar(incluir_dia="--incluir-dia" in argv)
        print("Kill switch apagado%s." % (" y bloqueo del dia quitado" if "--incluir-dia" in argv else ""))
    elif comando == "poner" and len(argv) == 3:
        poner(argv[1], argv[2])
        print("%s = %s" % (argv[1], argv[2]))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
