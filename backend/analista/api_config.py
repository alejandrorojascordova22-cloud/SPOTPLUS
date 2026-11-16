"""
API de configuracion del analista (para el panel de la app).
  GET  /api/analista/config        -> config actual
  POST /api/analista/config        -> {"config": {...}} guarda (valida tipos y valores)
  POST /api/analista/config/reset  -> vuelve a los valores iniciales
Solo lee/escribe backend/estrategia/config_estrategia.json. No toca MT5.
"""
import copy
import json
import os
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()
RUTA = Path(__file__).resolve().parent.parent / "estrategia" / "config_estrategia.json"
RUTA_INICIAL = RUTA.with_name("config_estrategia.inicial.json")   # copia de respaldo para "restaurar"

TFS = ["M1", "M3", "M5", "M15", "M30", "H1", "H2", "H4", "D1", "W1"]
ENUMS = {
    ("temporalidades", "modo"): ["auto", "manual"],
    ("direccion", "modo"): ["auto", "manual"],
    ("direccion", "manual"): ["alcista", "bajista", "acumulacion"],
    ("zonas_espera", "modo"): ["por_fuerza", "todas"],
    ("zonas_espera", "tfs"): ["auto", "manual"],
    ("confirmacion", "exigir"): ["rompimiento", "dos_puntos", "ninguna"],
    ("confirmacion", "micro_tfs"): ["auto", "manual"],
    ("confirmacion", "elegir"): ["mejor", "primera"],
    ("operaciones", "modo"): ["analisis", "dos", "solo_correr", "una"],
    ("riesgo", "modo"): ["porcentaje", "monto_fijo"],
}
LISTAS_TF = {("temporalidades", "seleccion"), ("zonas_espera", "tfs_manual"), ("confirmacion", "micro_manual")}
ROLES_TF = {("roles", "micro"), ("roles", "intermedio"), ("roles", "macro"), ("roles", "ultra_macro")}
RANGOS = {  # (minimo, maximo) para numeros
    ("riesgo", "porcentaje"): (0.01, 100), ("riesgo", "monto_fijo"): (0.01, 1e9),
    ("riesgo", "capital_inicial"): (1, 1e12), ("confluencias", "minimo"): (0, 10),
    ("lentes", "min_grupo"): (2, 6), ("lentes", "peso_vista_distinta"): (0, 1),
}


def _leer():
    cfg = json.loads(RUTA.read_text(encoding="utf-8"))
    # Opcion nueva: si tu JSON todavia no la trae, se agrega apagada (comportamiento de antes).
    if isinstance(cfg.get("ejecucion"), dict):
        cfg["ejecucion"].setdefault("todas_las_proyecciones", False)
    if isinstance(cfg.get("confirmacion"), dict):                  # barrido de liquidez micro (apagado por defecto)
        cfg["confirmacion"].setdefault("exigir_barrido_micro", False)
    if isinstance(cfg.get("operaciones"), dict):                   # asegurar ganancias si el marco mayor retrocede
        cfg["operaciones"].setdefault("asegurar_en_retroceso", True)
    if isinstance(cfg.get("temporalidades"), dict):               # lentes (vista + estructura): se agregan si faltan
        cfg["temporalidades"].setdefault("lentes", {
            "usar": True, "min_grupo": 2, "peso_vista_distinta": 0.5,
            "lista": [{"nombre": "naranja", "vista": "D1", "estructura": "H4"},
                      {"nombre": "azul", "vista": "H2", "estructura": "H1"},
                      {"nombre": "verde", "vista": "H1", "estructura": "M30"},
                      {"nombre": "verde_fino", "vista": "M30", "estructura": "M15"}]})
    return cfg


def _escribir(cfg):
    fd, tmp = tempfile.mkstemp(dir=str(RUTA.parent), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, RUTA)                       # escritura atomica: el analista nunca lee un archivo a medias


def _mezclar(actual, nuevo, ruta=()):
    """Mezcla `nuevo` sobre `actual` validando clave por clave. Lanza ValueError si algo no es valido."""
    if not isinstance(nuevo, dict):
        raise ValueError(f"{'.'.join(ruta) or 'config'}: se esperaba un objeto")
    for k, v in nuevo.items():
        if k.startswith("_"):
            continue
        r = ruta + (k,)
        if k not in actual:
            raise ValueError(f"opcion desconocida: {'.'.join(r)}")
        base = actual[k]
        if isinstance(base, dict):
            _mezclar(base, v, r)
            continue
        actual[k] = _validar(r, base, v)
    return actual


def _validar(r, base, v):
    nombre = ".".join(r)
    clave = (r[-2], r[-1]) if len(r) >= 2 else (r[-1],)
    if clave == ("estilo", "activo"):                  # null (ninguno) o uno de los perfiles
        if v is None or v in ("scalping", "intraday", "swing", "position"):
            return v
        raise ValueError(f"{nombre}: usa null, scalping, intraday, swing o position")
    if isinstance(base, bool):
        if not isinstance(v, bool):
            raise ValueError(f"{nombre}: debe ser true/false")
        return v
    if isinstance(base, str):
        permitidos = ENUMS.get(clave)
        if not isinstance(v, str) or (permitidos and v not in permitidos):
            raise ValueError(f"{nombre}: valor no valido ({v!r}); opciones: {permitidos}")
        return v
    if isinstance(base, (int, float)):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"{nombre}: debe ser un numero")
        lo, hi = RANGOS.get(clave, (0, 1e6))
        if not lo <= v <= hi:
            raise ValueError(f"{nombre}: debe estar entre {lo} y {hi}")
        return v if not isinstance(base, int) or isinstance(v, int) else int(round(v))
    if isinstance(base, list):
        if not isinstance(v, list):
            raise ValueError(f"{nombre}: debe ser una lista")
        if clave in ROLES_TF:                            # un rol puede quedar vacio
            if any(x not in TFS for x in v):
                raise ValueError(f"{nombre}: solo temporalidades de {TFS}")
            return [x for x in TFS if x in v]
        if clave == ("avisos", "estados"):
            if not v or any(x not in ("dentro", "confirmada") for x in v):
                raise ValueError(f"{nombre}: elige entre dentro y confirmada")
            return [x for x in ("dentro", "confirmada") if x in v]
        if clave == ("lentes", "lista"):                  # cada lente = {nombre, vista, estructura}
            if not v or len(v) > 20:
                raise ValueError(f"{nombre}: de 1 a 20 lentes")
            out = []
            for l in v:
                if not isinstance(l, dict) or l.get("vista") not in TFS or l.get("estructura") not in TFS:
                    raise ValueError(f"{nombre}: cada lente necesita vista y estructura de {TFS}")
                if TFS.index(l["estructura"]) > TFS.index(l["vista"]):
                    raise ValueError(f"{nombre}: la estructura no puede ser mayor que la vista ({l['vista']}/{l['estructura']})")
                out.append({"nombre": str(l.get("nombre") or f"{l['vista']}/{l['estructura']}")[:30],
                            "vista": l["vista"], "estructura": l["estructura"]})
            return out
        if clave in LISTAS_TF:
            if not v or any(x not in TFS for x in v):
                raise ValueError(f"{nombre}: elige al menos una temporalidad de {TFS}")
            return [x for x in TFS if x in v]            # orden estandar, sin repetidos
        if clave == ("operaciones", "reparto"):
            if len(v) != 2 or any(isinstance(x, bool) or not isinstance(x, (int, float)) or x < 0 for x in v) or sum(v) <= 0:
                raise ValueError(f"{nombre}: dos numeros positivos (corta, correr)")
            s = float(sum(v))
            return [round(v[0] / s, 4), round(v[1] / s, 4)]
        if any(isinstance(x, bool) or not isinstance(x, (int, float)) for x in v) or not v:
            raise ValueError(f"{nombre}: lista de numeros")
        return v
    return v


@router.get("/api/analista/config")
def obtener_config():
    try:
        return {"config": _leer(), "temporalidades_disponibles": TFS}
    except FileNotFoundError:
        raise HTTPException(404, "No existe backend/estrategia/config_estrategia.json")


@router.post("/api/analista/config")
def guardar_config(cuerpo: dict):
    try:
        actual = _leer()
    except FileNotFoundError:
        raise HTTPException(404, "No existe backend/estrategia/config_estrategia.json")
    if not RUTA_INICIAL.exists():
        _escribir_a(RUTA_INICIAL, actual)                # primera vez: guarda los valores originales
    try:
        nuevo = _mezclar(copy.deepcopy(actual), cuerpo.get("config", {}))
    except ValueError as e:
        raise HTTPException(400, str(e))
    _escribir(nuevo)
    return {"ok": True, "config": nuevo}


@router.post("/api/analista/config/reset")
def restaurar_config():
    if not RUTA_INICIAL.exists():
        raise HTTPException(404, "Todavia no hay valores originales guardados (se crean la primera vez que guardas).")
    cfg = json.loads(RUTA_INICIAL.read_text(encoding="utf-8"))
    _escribir(cfg)
    return {"ok": True, "config": cfg}


def _escribir_a(ruta, cfg):
    Path(ruta).write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")

# ---- lista de activos: SEGUIR (avisos) y OPERAR (abre ordenes) ----
import re as _re

RUTA_WATCH = Path(__file__).resolve().parent / "watchlist.json"
_SIMBOLO = _re.compile(r"^[A-Z0-9._#\-]{2,20}$")
_proyecciones_operadas = set()
_proyecciones_operadas_lock = threading.Lock()


def _leer_watch():
    return json.loads(RUTA_WATCH.read_text(encoding="utf-8").lstrip("\ufeff"))


def _simbolos_operar(w, cfg):
    operar = w.get("operar")
    if operar is None:
        operar = str((cfg.get("ejecucion") or {}).get("simbolos", "")).split(",")
    return {str(s).strip().upper() for s in operar if str(s).strip()}


@router.get("/api/analista/watchlist")
def obtener_watchlist():
    try:
        w = _leer_watch()
    except FileNotFoundError:
        raise HTTPException(404, "No existe backend/analista/watchlist.json")
    seguir = list(w.get("simbolos", []))
    try:
        cfg = _leer()
    except FileNotFoundError:
        cfg = {}
    ej = cfg.get("ejecucion", {})
    operar = w.get("operar")
    if operar is None:   # primera vez: toma la lista vieja de la config
        operar = [s.strip().upper() for s in str(ej.get("simbolos", "")).split(",") if s.strip()]
    return {"simbolos": seguir, "operar": [s for s in operar if s in seguir],
            "ejecucion_activa": bool(ej.get("activa", False))}


@router.post("/api/analista/watchlist")
def guardar_watchlist(cuerpo: dict):
    try:
        w = _leer_watch()
    except FileNotFoundError:
        raise HTTPException(404, "No existe backend/analista/watchlist.json")
    simbolos, operar = cuerpo.get("simbolos"), cuerpo.get("operar", [])
    if not isinstance(simbolos, list) or not isinstance(operar, list):
        raise HTTPException(400, "simbolos y operar deben ser listas")
    limpios = []
    for s in simbolos:
        s = str(s).strip().upper()
        if not _SIMBOLO.match(s):
            raise HTTPException(400, f"simbolo no valido: {s!r}")
        if s not in limpios:
            limpios.append(s)
    if len(limpios) > 60:
        raise HTTPException(400, "maximo 60 activos")
    ops = [s for s in dict.fromkeys(str(x).strip().upper() for x in operar) if s in limpios]
    w["simbolos"], w["operar"] = limpios, ops
    fd, tmp = tempfile.mkstemp(dir=str(RUTA_WATCH.parent), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(w, f, indent=2, ensure_ascii=False)
    os.replace(tmp, RUTA_WATCH)   # escritura atomica
    return {"ok": True, "simbolos": limpios, "operar": ops}


# ---- estado REAL de cada activo: lo que el bot hara de verdad ----
def _leer_latido():
    try:
        from backend.datos import ruta_archivo
        ruta = ruta_archivo("analista/escaner_estado.json", Path(__file__).resolve().parent / "escaner_estado.json")
        return json.loads(Path(ruta).read_text(encoding="utf-8"))
    except Exception:
        return None


@router.get("/api/analista/activos/estado")
def estado_activos():
    from datetime import datetime
    try:
        w = _leer_watch()
    except FileNotFoundError:
        raise HTTPException(404, "No existe backend/analista/watchlist.json")
    try:
        cfg = _leer()
    except FileNotFoundError:
        cfg = {}
    ej = cfg.get("ejecucion", {}) or {}
    activa = bool(ej.get("activa", False))
    solo_demo = bool(ej.get("solo_cuenta_demo", True))
    maximo = int(ej.get("max_posiciones_por_simbolo", 1) or 0)
    spread_max = float(ej.get("spread_maximo_puntos", 0) or 0)
    seguir = list(w.get("simbolos", []))
    operar = w.get("operar")
    if operar is None:
        operar = [s.strip().upper() for s in str(ej.get("simbolos", "")).split(",") if s.strip()]
    operar = {str(s).upper() for s in operar}
    suf = w.get("sufijo", "")

    # escaner: corre o no
    lat = _leer_latido()
    intervalo = int((lat or {}).get("intervalo_min", w.get("intervalo_min", 5)) or 5)
    esc = {"corriendo": False, "ultima": None, "hace_min": None, "intervalo_min": intervalo}
    sin_datos, errores = set(), {}
    if lat and lat.get("ts"):
        try:
            edad = (datetime.now() - datetime.fromisoformat(lat["ts"])).total_seconds()
            esc.update(ultima=lat["ts"], hace_min=round(edad / 60, 1), corriendo=edad <= (2 * intervalo + 2) * 60)
        except ValueError:
            pass
        sin_datos = set(lat.get("sin_datos") or [])
        errores = dict(lat.get("errores") or {})

    # MT5 (este proceso)
    c = None
    cuenta = {}
    try:
        from backend.conexion import conexion_mt5 as c
        cuenta = c.obtener_info_cuenta() or {}
    except Exception:
        c = None
    mt5_ok = bool(cuenta)
    es_real = bool(cuenta.get("es_real"))

    activos = []
    for base in seguir:
        sim = base if base.endswith(suf) else base + suf
        quiere = base.upper() in operar
        estado, detalle = "seguir", "Solo aviso por Telegram"
        if not mt5_ok:
            estado, detalle = "sin_mt5", "No pude consultar MT5 desde el backend"
        else:
            si = None
            try:
                with c.bloqueo_mt5():
                    si = c.mt5.symbol_info(sim)
                    pleno = si is not None and si.trade_mode == c.mt5.SYMBOL_TRADE_MODE_FULL
                    spread = si.spread if si is not None else 0
            except Exception:
                si, pleno, spread = None, False, 0
            try:
                posiciones = len(c.obtener_posiciones_abiertas(sim))
            except Exception:
                posiciones = 0
            if si is None or sim in sin_datos:
                estado, detalle = "no_existe", "No existe o sin datos en MT5 con el nombre %s (revisa nombre/sufijo)" % sim
            elif sim in errores:
                estado, detalle = "problema", "Error en el ultimo escaneo: %s" % errores[sim]
            elif not esc["corriendo"]:
                estado, detalle = "sin_escaner", "Escaner apagado: no se abren ordenes ni se envian avisos"
            elif not quiere:
                estado, detalle = "seguir", "Solo aviso por Telegram"
            elif not activa:
                estado, detalle = "seguir", "Marcado Operar, pero el paso 9 esta en Solo avisar"
            elif solo_demo and es_real:
                estado, detalle = "bloqueado", "Cuenta REAL: bloqueado (solo_cuenta_demo)"
            elif not pleno:
                estado, detalle = "cerrado", "El broker no permite operar ahora (mercado cerrado)"
            elif spread_max > 0 and spread > spread_max:
                estado, detalle = "problema", "Spread %s > maximo %s: no abriria ahora" % (spread, spread_max)
            elif maximo > 0 and posiciones >= maximo:
                estado, detalle = "ocupado", "Ya tiene %d posicion(es) abierta(s): no abre otra" % posiciones
            else:
                estado, detalle = "opera", "Abrira ordenes cuando haya una senal confirmada"
        activos.append({"simbolo": base, "mt5": sim, "operar": quiere, "estado": estado, "detalle": detalle})

    return {
        "escaner": esc,
        "ejecucion_activa": activa,
        "cuenta_real": es_real,
        "mt5": mt5_ok,
        "activos": activos,
        "resumen": {
            "abriran": sum(1 for a in activos if a["estado"] == "opera"),
            "solo_avisan": sum(1 for a in activos if a["estado"] == "seguir"),
            "en_espera": sum(1 for a in activos if a["estado"] in ("ocupado", "cerrado")),
            "con_problema": sum(1 for a in activos if a["estado"] not in ("opera", "seguir", "ocupado", "cerrado")),
        },
    }


def _info_escaner(lat, w):
    from datetime import datetime

    intervalo = int((lat or {}).get("intervalo_min", w.get("intervalo_min", 5)) or 5)
    esc = {"corriendo": False, "ultima": None, "hace_min": None, "intervalo_min": intervalo}
    if lat and lat.get("ts"):
        try:
            edad = (datetime.now() - datetime.fromisoformat(lat["ts"])).total_seconds()
            esc.update(
                ultima=lat["ts"],
                hace_min=round(edad / 60, 1),
                corriendo=edad <= (intervalo + 2) * 60,
            )
        except ValueError:
            pass
    return esc


@router.get("/api/analista/proyecciones")
def obtener_proyecciones():
    try:
        w = _leer_watch()
    except FileNotFoundError:
        raise HTTPException(404, "No existe backend/analista/watchlist.json")
    try:
        cfg = _leer()
    except FileNotFoundError:
        raise HTTPException(404, "No existe backend/estrategia/config_estrategia.json")

    lat = _leer_latido() or {}
    esc = _info_escaner(lat, w)
    ejecucion_activa = bool((cfg.get("ejecucion") or {}).get("activa"))
    solo_cuenta_demo = bool((cfg.get("ejecucion") or {}).get("solo_cuenta_demo", True))
    operar = _simbolos_operar(w, cfg)
    todas = bool((cfg.get("ejecucion") or {}).get("todas_las_proyecciones"))
    proyecciones = lat.get("proyecciones") or {}

    from backend.conexion import conexion_mt5 as c

    cuenta = c.obtener_info_cuenta() or {}
    activos = []
    for base in w.get("simbolos", []):
        guardado = proyecciones.get(base, {})
        escenarios = guardado.get("escenarios") or []
        simbolo_mt5 = guardado.get("mt5") or (base + w.get("sufijo", ""))
        if not esc["corriendo"]:
            estado = "escaner_apagado"
            detalle = "Escáner apagado o sin actualizar; proyección no vigente."
        elif guardado.get("error") == "sin_datos":
            estado = "sin_datos"
            detalle = "MT5 no devolvió velas para %s; confirma el nombre del símbolo o el sufijo del bróker." % simbolo_mt5
        elif guardado.get("error"):
            estado = "problema"
            detalle = str(guardado["error"])
        elif base not in proyecciones:
            estado = "pendiente"
            detalle = "Esperando la primera proyección para %s en el próximo escaneo." % simbolo_mt5
        elif not escenarios:
            estado = "sin_senal"
            detalle = "Sin oportunidad detectada por la estrategia en la última vuelta."
        elif any(e.get("estado") == "confirmada" for e in escenarios):
            estado = "confirmada"
            detalle = "La estrategia confirmó una señal."
        else:
            estado = "en_zona"
            detalle = "La estrategia detectó una zona; falta confirmar la entrada."

        posiciones = c.obtener_posiciones_abiertas(simbolo_mt5) if cuenta else []
        escenarios_con_estado = []
        for escenario in escenarios:
            direccion = "compra" if escenario.get("direccion") == "alcista" else "venta"
            nombres_operacion = {
                str(op.get("nombre", "")).strip().casefold()
                for op in escenario.get("operaciones", [])
                if op.get("nombre")
            }
            en_curso = any(
                posicion.get("tipo") == direccion
                and any(
                    str(posicion.get("comment") or "").casefold().startswith("spotplus " + nombre)
                    for nombre in nombres_operacion
                )
                for posicion in posiciones
            )
            escenario_actual = dict(escenario)
            escenario_actual["en_curso"] = en_curso
            escenarios_con_estado.append(escenario_actual)
        activos.append({
            "simbolo": base,
            "mt5": simbolo_mt5,
            "marcado_operar": base.upper() in operar,
            "estado": estado,
            "detalle": detalle,
            "escenarios": escenarios_con_estado if esc["corriendo"] else [],
            "posiciones": posiciones,
        })

    return {
        "escaner": esc,
        "ejecucion_activa": ejecucion_activa,
        "todas_las_proyecciones": todas,
        "mt5_conectado": bool(cuenta),
        "cuenta_real": bool(cuenta.get("es_real")),
        "moneda": cuenta.get("moneda"),
        # Tu eliges: el boton manual sirve con el bot en automatico o solo avisando.
        "manual_permitido": bool(
            esc["corriendo"]
            and cuenta
            and (not solo_cuenta_demo or not cuenta.get("es_real"))
        ),
        "activos": activos,
    }


@router.post("/api/analista/proyecciones/operar")
def operar_proyeccion(cuerpo: dict):
    simbolo = str(cuerpo.get("simbolo", "")).strip().upper()
    clave = str(cuerpo.get("clave", "")).strip()
    if not _SIMBOLO.fullmatch(simbolo) or not clave:
        raise HTTPException(400, "Se requiere un símbolo y una proyección válidos.")

    w = _leer_watch()
    if simbolo not in w.get("simbolos", []):
        raise HTTPException(404, "El activo ya no está en MIS ACTIVOS.")
    cfg = _leer()
    ej = cfg.get("ejecucion") or {}

    lat = _leer_latido() or {}
    esc = _info_escaner(lat, w)
    if not esc["corriendo"]:
        raise HTTPException(409, "El escáner está apagado o su proyección ya venció.")
    escenarios = (lat.get("proyecciones") or {}).get(simbolo, {}).get("escenarios") or []
    proyeccion = next((e for e in escenarios if e.get("clave") == clave), None)
    if proyeccion is None or proyeccion.get("estado") != "confirmada":
        raise HTTPException(409, "La señal ya no está confirmada. Recarga las proyecciones.")
    if proyeccion.get("ejecutada"):
        raise HTTPException(409, "El bot ya abrió esta proyección; no se duplica.")

    from backend.conexion import conexion_mt5 as c
    from backend.analista.escaner import ejecutar_escenario

    cuenta = c.obtener_info_cuenta()
    if not cuenta:
        raise HTTPException(503, "MT5 no está conectado; no se envió ninguna orden.")
    if ej.get("solo_cuenta_demo", True) and cuenta.get("es_real"):
        raise HTTPException(403, "La configuración solo permite operar en cuenta demo.")

    id_operacion = (simbolo, clave)
    with _proyecciones_operadas_lock:
        if id_operacion in _proyecciones_operadas:
            raise HTTPException(409, "Esta proyección ya se usó para una entrada manual.")
        resultado = ejecutar_escenario(
            proyeccion,
            proyeccion["simbolo"],
            proyeccion.get("lotes"),
            cfg,
            cuenta,
            w,
            manual=True,
        )
        abiertas = [linea for linea in resultado if " ABIERTA " in linea]
        if abiertas:
            _proyecciones_operadas.add(id_operacion)
    if not resultado:
        raise HTTPException(409, "No se pudo ejecutar la proyección; revisa su estado y las condiciones de MT5.")
    return {"ok": bool(abiertas), "resultados": resultado}
