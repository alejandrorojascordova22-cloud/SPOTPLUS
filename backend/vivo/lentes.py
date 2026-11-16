"""Estructura confirmada de los lentes para dibujarla en el gráfico en vivo."""
import pandas as pd

from ..estrategia import estrategia


def _marcas_estructura(velas, pivote_k, direccion):
    df = pd.DataFrame(velas)
    if len(df) < 2 * pivote_k + 1:
        return [], []

    pivotes = estrategia.pivotes(df, pivote_k)
    ultimo = {"H": None, "L": None}
    marcas = []
    quiebres = []

    for indice, precio, tipo in pivotes:
        clase = "primero"
        anterior = ultimo[tipo]
        if anterior is not None:
            if tipo == "H":
                clase = "HH" if precio > anterior else "LH"
            else:
                clase = "HL" if precio > anterior else "LL"
        ultimo[tipo] = precio
        marcas.append({
            "time": int(df.iloc[indice]["time"]),
            "precio": float(precio),
            "tipo": "high" if tipo == "H" else "low",
            "clase": clase,
        })

        lado = "alcista" if tipo == "H" else "bajista"
        for i in range(indice + 1, len(df)):
            cierre = float(df.iloc[i]["close"])
            roto = cierre > precio if tipo == "H" else cierre < precio
            if roto:
                quiebres.append({
                    "time": int(df.iloc[i]["time"]),
                    "precio": float(precio),
                    "direccion": lado,
                    "tipo": "BOS" if lado == direccion else "CHOCH",
                })
                break

    unicos = {}
    for q in quiebres:
        unicos[(q["time"], q["direccion"], q["precio"])] = q
    recientes = sorted(unicos.values(), key=lambda q: q["time"])[-4:]
    return marcas[-12:], recientes


def _marcas_estructura_historica(df, pivote_k, direccion):
    """Calcula pivotes y quiebres históricos sin mostrar eventos antes de confirmarse."""
    pivotes = estrategia.pivotes(df, pivote_k)
    ultimo = {"H": None, "L": None}
    marcas = []
    por_confirmacion = {}

    for indice, precio, tipo in pivotes:
        clase = "primero"
        anterior = ultimo[tipo]
        if anterior is not None:
            if tipo == "H":
                clase = "HH" if precio > anterior else "LH"
            else:
                clase = "HL" if precio > anterior else "LL"
        ultimo[tipo] = precio
        confirmacion = indice + pivote_k
        marca = {
            "time": int(df.iloc[indice]["time"]),
            "confirmacion": int(df.iloc[confirmacion]["time"]),
            "precio": float(precio),
            "tipo": "high" if tipo == "H" else "low",
            "clase": clase,
        }
        marcas.append(marca)
        por_confirmacion.setdefault(confirmacion, []).append((tipo, precio))

    quiebres = []
    activos = {"H": None, "L": None}
    for indice in range(len(df)):
        cierre = float(df.iloc[indice]["close"])
        for tipo, lado in (("H", "alcista"), ("L", "bajista")):
            pivote = activos[tipo]
            if pivote is None or indice <= pivote["confirmacion"] or pivote["roto"]:
                continue
            roto = cierre > pivote["precio"] if tipo == "H" else cierre < pivote["precio"]
            if roto:
                pivote["roto"] = True
                quiebres.append({
                    "time": int(df.iloc[indice]["time"]),
                    "precio": float(pivote["precio"]),
                    "direccion": lado,
                    "tipo": "BOS" if lado == direccion else "CHOCH",
                })

        for tipo, precio in por_confirmacion.get(indice, []):
            activos[tipo] = {
                "precio": precio,
                "confirmacion": indice,
                "roto": False,
            }

    return marcas, quiebres


def obtener_lentes_historicos(velas_tf, cargar_config):
    """Construye los lentes configurados con estructura histórica para el replay."""
    config = cargar_config()
    lentes_cfg = estrategia.cfg_lentes(config)
    if not lentes_cfg:
        return {"lentes": [], "zonas": [], "temporalidades_faltantes": []}

    dfs = {}
    faltantes = []
    for tf in estrategia.tfs_de_lentes(config):
        df = velas_tf.get(tf)
        if df is None or len(df) < 60:
            faltantes.append(tf)
            continue
        dfs[tf] = df

    evaluados = estrategia.evaluar_lentes(
        dfs, lentes_cfg, {}, config["estructura"],
    )
    evaluados_por_nombre = {l["nombre"]: l for l in evaluados}
    pivote_k = config["estructura"]["pivote_k"]
    lentes = []
    for lente in lentes_cfg:
        tf = lente["estructura"]
        df = dfs.get(tf)
        evaluado = evaluados_por_nombre.get(lente["nombre"])
        direccion = evaluado["dir"] if evaluado else "acumulacion"
        marcas, quiebres = ([], [])
        if df is not None and len(df) >= 2 * pivote_k + 1:
            marcas, quiebres = _marcas_estructura_historica(
                df, pivote_k, direccion,
            )
        lentes.append({
            "nombre": lente["nombre"],
            "vista": lente["vista"],
            "estructura": tf,
            "direccion": direccion,
            "direccion_vista": evaluado["dir_vista"] if evaluado else direccion,
            "fase": evaluado["fase"] if evaluado else "sin datos",
            "pivotes": marcas,
            "quiebres": quiebres,
        })

    return {
        "lentes": lentes,
        "zonas": [],
        "temporalidades_faltantes": faltantes,
    }


def obtener_lentes(simbolo, obtener_velas, cargar_config):
    """Calcula vistas de solo lectura con las velas reales de cada marco configurado."""
    config = cargar_config()
    lentes_cfg = estrategia.cfg_lentes(config)
    if not lentes_cfg:
        return {"lentes": [], "zonas": [], "temporalidades_faltantes": []}

    tfs = estrategia.tfs_de_lentes(config)
    velas_tf = {}
    dfs = {}
    faltantes = []
    for tf in tfs:
        velas = obtener_velas(simbolo, tf, 300)
        if not velas or len(velas) < 60:
            faltantes.append(tf)
            continue
        velas_tf[tf] = velas
        dfs[tf] = pd.DataFrame(velas)

    evaluados = estrategia.evaluar_lentes(dfs, lentes_cfg, {}, config["estructura"])
    lentes = []
    for lente in evaluados:
        tf = lente["estructura"]
        marcas, quiebres = _marcas_estructura(
            velas_tf[tf], config["estructura"]["pivote_k"], lente["dir"],
        )
        lentes.append({
            "nombre": lente["nombre"],
            "vista": lente["vista"],
            "estructura": tf,
            "direccion": lente["dir"],
            "direccion_vista": lente["dir_vista"],
            "fase": lente["fase"],
            "pivotes": marcas,
            "quiebres": quiebres,
        })

    escenarios = estrategia.analizar(simbolo, dfs, config)
    zonas = [{
        "estructura": e["zona_tf"],
        "tipo": e["zona"],
        "direccion": e["direccion"],
        "estado": e["estado"],
        "rango": [float(e["zona_rango"][0]), float(e["zona_rango"][1])],
    } for e in escenarios]
    return {"lentes": lentes, "zonas": zonas, "temporalidades_faltantes": faltantes}
