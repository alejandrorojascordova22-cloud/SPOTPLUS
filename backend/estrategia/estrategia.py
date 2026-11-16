"""SpotPlus - estrategia modular (modo analista, NO ejecuta ordenes).
Cada concepto se enciende/apaga en config_estrategia.json.
velas = {"M5": df, "M15": df, "H1": df, ...}  df con columnas open, high, low, close.
"""
import json, os
import numpy as np
import pandas as pd

RUTA_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config_estrategia.json")


def _fusionar(base, extra):
    """Mezcla recursiva: los dict se combinan, todo lo demas (numeros, textos, listas) se reemplaza."""
    out = dict(base)
    for k, v in extra.items():
        out[k] = _fusionar(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def aplicar_estilo(cfg):
    """Estilo de operativa (scalping / intraday / swing). Si "estilo.activo" es null, no cambia nada.
    El perfil elegido pisa valores de la config (en memoria; el JSON no se toca). Su bloque
    "escaner" (intervalo, cooldown, gatillo) lo usa el escaner y queda en cfg["_estilo"]."""
    est = cfg.get("estilo") or {}
    nombre = est.get("activo")
    perfil = (est.get("perfiles") or {}).get(nombre) if nombre else None
    if not perfil:
        return cfg
    out = _fusionar(cfg, {k: v for k, v in perfil.items() if k != "escaner"})
    out["_estilo"] = dict(nombre=nombre, escaner=perfil.get("escaner") or {})
    return out


def cargar_config(ruta=RUTA_CFG):
    with open(ruta, encoding="utf-8") as f:
        return aplicar_estilo(json.load(f))


# ---------------- utilidades ----------------
def atr(df, n=14):  # rapido-v1
    h, l, c = df["high"].to_numpy(dtype=float), df["low"].to_numpy(dtype=float), df["close"].to_numpy(dtype=float)
    if len(h) > n and n > 0:
        hh, ll, pc = h[-n:], l[-n:], c[-n - 1:-1]
        tr = np.maximum(hh - ll, np.maximum(np.abs(hh - pc), np.abs(ll - pc)))
        v = tr.mean()
        if v == v:
            return float(v)
    return float((df["high"] - df["low"]).mean())


def _espejo(df):
    e = df.copy()
    e["open"], e["close"] = -df["open"], -df["close"]
    e["high"], e["low"] = -df["low"], -df["high"]
    return e


def pivotes(df, k=3):
    h, l = df["high"].to_numpy(), df["low"].to_numpy()
    n = len(h)
    out = []
    if n > 2 * k:
        w = 2 * k + 1
        mx = np.lib.stride_tricks.sliding_window_view(h, w).max(axis=1)
        mn = np.lib.stride_tricks.sliding_window_view(l, w).min(axis=1)
        es_h = h[k:n - k] == mx
        es_l = (l[k:n - k] == mn) & ~es_h
        for j in np.flatnonzero(es_h | es_l):
            i = int(j) + k
            out.append((i, float(h[i]), "H") if es_h[j] else (i, float(l[i]), "L"))
    res = []
    for p in out:  # alternar H/L
        if res and res[-1][2] == p[2]:
            if (p[2] == "H" and p[1] > res[-1][1]) or (p[2] == "L" and p[1] < res[-1][1]):
                res[-1] = p
        else:
            res.append(p)
    return res


# ---------------- 0. lentes (vista + estructura) ----------------
# Un "lente" = (vista, estructura): en que temporalidad VES el grafico y de que temporalidad
# LEES la estructura (impulso / retroceso). Ej. naranja: ves D1, estructura de H4.
# Los lentes vecinos se AGRUPAN cuando coinciden en direccion y en fase: eso da confianza.
ORDEN_TF = ["M1", "M3", "M5", "M15", "M30", "H1", "H2", "H4", "D1", "W1"]


def cfg_lentes(cfg):
    """Lentes validos de la config, ordenados de mayor a menor estructura. [] si estan apagados."""
    cl = (cfg.get("temporalidades") or {}).get("lentes") or {}
    if not cl.get("usar"):
        return []
    out = []
    for l in cl.get("lista") or []:
        v, e = l.get("vista"), l.get("estructura")
        if v in ORDEN_TF and e in ORDEN_TF and ORDEN_TF.index(e) <= ORDEN_TF.index(v):
            out.append(dict(nombre=l.get("nombre") or "%s/%s" % (v, e), vista=v, estructura=e))
    out.sort(key=lambda l: (-ORDEN_TF.index(l["estructura"]), -ORDEN_TF.index(l["vista"])))
    return out


def tfs_de_lentes(cfg):
    """Temporalidades que hay que descargar para poder armar los lentes."""
    out = []
    for l in cfg_lentes(cfg):
        for t in (l["vista"], l["estructura"]):
            if t not in out:
                out.append(t)
    return out


def _fase(piv, dr, cierre):
    """impulso = la pierna actual va a favor de la direccion; retroceso = va en contra."""
    if dr == "acumulacion" or not piv:
        return "rango"
    _, pv, pt = piv[-1]
    if pt == "H":
        pierna = "arriba" if cierre > pv else "abajo"
    else:
        pierna = "abajo" if cierre < pv else "arriba"
    a_favor = (dr == "alcista" and pierna == "arriba") or (dr == "bajista" and pierna == "abajo")
    return "impulso" if a_favor else "retroceso"


def evaluar_lentes(velas, lentes, info, ce):
    """Direccion y fase de cada lente (solo estructura CONFIRMADA: los pivotes ya tienen k velas a cada lado)."""
    def piv_tf(tf, df):
        if tf in info:
            return info[tf]["piv"]
        return _memo_get(("piv", tf, id(df), ce["pivote_k"]), df, lambda: pivotes(df, ce["pivote_k"]))

    res = []
    for l in lentes:
        de, dv = velas.get(l["estructura"]), velas.get(l["vista"])
        if de is None or len(de) < 60:
            continue
        pe = piv_tf(l["estructura"], de)
        dir_e = direccion(pe)
        dir_v = direccion(piv_tf(l["vista"], dv)) if dv is not None and len(dv) >= 60 else dir_e
        res.append(dict(l, dir=dir_e, dir_vista=dir_v, fase=_fase(pe, dir_e, float(de["close"].iloc[-1]))))
    return res


def alineacion_lentes(res, dg, cl):
    """(alineacion 0..1, grupos). Peso 1 si estructura y vista apuntan a dg; peso_vista_distinta si solo la estructura;
    0 si la estructura contradice o esta en rango. Grupo = lentes vecinos a favor de dg con la misma fase."""
    if not res:
        return None, []
    pv = float(cl.get("peso_vista_distinta", 0.5))
    for r in res:
        r["coincide"] = r["dir"] == dg
        r["peso"] = 0.0 if not r["coincide"] else (1.0 if r["dir_vista"] == dg else pv)
    ali = sum(r["peso"] for r in res) / len(res)
    grupos, cur = [], []
    for r in res + [None]:
        if r is not None and r["coincide"] and (not cur or cur[-1]["fase"] == r["fase"]):
            cur.append(r)
            continue
        if len(cur) >= int(cl.get("min_grupo", 2)):
            grupos.append(dict(fase=cur[0]["fase"], lentes=[x["nombre"] for x in cur],
                               tfs=" + ".join("%s/%s" % (x["vista"], x["estructura"]) for x in cur)))
        cur = [r] if (r is not None and r["coincide"]) else []
    return ali, grupos


def _fase_marco_superior(lres, tf_zona):
    """Fase (impulso/retroceso) del lente cuya estructura es la inmediata superior a la de la zona.
    Si la zona es H1 y hay lente con estructura H2, se usa ese. None si no hay lentes por encima."""
    if not lres or tf_zona not in ORDEN_TF:
        return None
    i0 = ORDEN_TF.index(tf_zona)
    sup = [r for r in lres if ORDEN_TF.index(r["estructura"]) > i0]
    if not sup:
        return None
    return min(sup, key=lambda r: ORDEN_TF.index(r["estructura"]))["fase"]


# ---------------- 1. direccion ----------------
def direccion(piv):
    H = [p for p in piv if p[2] == "H"][-2:]
    L = [p for p in piv if p[2] == "L"][-2:]
    if len(H) < 2 or len(L) < 2:
        return "acumulacion"
    if H[1][1] > H[0][1] and L[1][1] > L[0][1]:
        return "alcista"
    if H[1][1] < H[0][1] and L[1][1] < L[0][1]:
        return "bajista"
    return "acumulacion"


# ---------------- 2. rompimiento y su fuerza ----------------
def _impulso(d, piv, ce, a):
    """d en 'espacio alcista'. Busca el rompimiento (BOS) mas reciente."""
    h, c, o = d["high"].values, d["close"].values, d["open"].values
    for p in reversed([p for p in piv if p[2] == "H"]):
        i, precio = p[0], p[1]
        idx = np.where(c[i + 1:] > precio)[0]
        if len(idx) == 0:
            continue
        j = i + 1 + int(idx[0])
        lows = [q for q in piv if q[2] == "L" and q[0] < j]
        if not lows:
            continue
        org = lows[-1]
        ext_i = j + int(np.argmax(h[j:]))
        if h[ext_i] <= org[1]:
            continue
        cuerpo = abs(c[j] - o[j]) / a
        fz = "fuerte" if cuerpo >= ce["fuerte_atr"] else "medio" if cuerpo >= ce["medio_atr"] else "debil"
        return dict(bos_i=j, roto_i=i, org_i=org[0], org=org[1], ext=float(h[ext_i]),
                    fuerza=fz, cuerpo_atr=round(float(cuerpo), 2))
    return None


# ---------------- 3. zonas de espera ----------------
def _zonas(d, imp, cz):
    hi, lo = imp["ext"], imp["org"]
    rng = hi - lo
    nv = lambda p: hi - rng * p / 100.0
    t, f = cz["tipos"], imp["fuerza"]
    por_fuerza = cz["modo"] == "por_fuerza"
    zs = []

    def add(tipo, a, b, solo_conf=False):
        zs.append(dict(tipo=tipo, bajo=min(a, b), alto=max(a, b), solo_confirmada=solo_conf))

    if t["obc"] and (not por_fuerza or f == "debil"):          # rompimiento debil -> OBC
        r = d.iloc[imp["org_i"]]
        add("OBC", r["low"], max(r["open"], r["close"]))
    if t["flip"] and (not por_fuerza or f == "medio"):         # rompimiento medio -> FLIP
        r = d.iloc[imp["roto_i"]]
        add("FLIP", min(r["open"], r["close"]), r["high"])
    if t["fibo"] and (not por_fuerza or f == "fuerte"):        # rompimiento fuerte -> 27/38/50
        n = cz["niveles_fibo"]
        add("FIBO %d-%d" % (min(n), max(n)), nv(min(n)), nv(max(n)))
    if t["ev2"]:                                               # EV2 110/127/138 (toma de liquidez)
        n = cz["niveles_ev2"]
        add("EV2", nv(min(n)), nv(max(n)), cz["ev2_exigir_confirmacion"])
    niveles = [("88.6", nv(88.6))] if t["n886"] else []
    return zs, niveles, hi, lo


def _orig(z, s):
    return z if s == 1 else dict(z, bajo=-z["alto"], alto=-z["bajo"])


# ---------------- 4. liquidez ----------------
def pools_liquidez(df, piv, a, tol):
    res = []
    for tipo in ("H", "L"):
        ps = sorted([p for p in piv if p[2] == tipo], key=lambda p: p[1])
        g = []
        for p in ps + [None]:
            if p is not None and g and p[1] - g[-1][1] <= a * tol:
                g.append(p)
                continue
            if len(g) >= 2:
                pr = float(np.mean([x[1] for x in g]))
                ui = max(x[0] for x in g)
                post = df["high"].iloc[ui + 1:].max() if tipo == "H" else df["low"].iloc[ui + 1:].min()
                barrido = bool(len(df) > ui + 1 and ((tipo == "H" and post > pr) or (tipo == "L" and post < pr)))
                res.append(dict(tipo=tipo, precio=pr, n=len(g), barrido=barrido))
            g = [p] if p is not None else []
    return res


# ---------------- 5. confirmacion micro ----------------
def confirmar(dm, zona, s, cc):
    d = dm if s == 1 else _espejo(dm)
    lo_z, hi_z = (zona["bajo"], zona["alto"]) if s == 1 else (-zona["alto"], -zona["bajo"])
    n = cc["ventana_velas"]
    ini = max(len(d) - n, 0)
    tail = d.iloc[ini:]
    toc = np.where((tail["low"].values <= hi_z) & (tail["high"].values >= lo_z))[0]
    if len(toc) == 0:
        return None
    t = ini + int(toc[-1])
    ini_p = max(t - cc["ventana_previa"], 0)
    sub = d.iloc[ini_p:]
    piv = pivotes(sub, cc["pivote_k"])
    Hs = [p[1] for p in piv if p[2] == "H"][-2:]
    cierre = float(d["close"].iloc[-1])
    puntos = sum(1 for hv in Hs if cierre > hv)           # cuantos maximos se llevo (0, 1 o 2)
    if len(Hs) == 2 and cierre > Hs[0] and cierre <= Hs[1]:
        puntos = 0                                         # solo cuenta si rompe en orden
    sl_up = float(d["low"].iloc[t:].min())
    # barrido micro (Maria Rondon): al entrar a la zona el precio se llevo un minimo previo (compras;
    # en ventas el espejo hace lo mismo con maximos) y recien despues confirma el rompimiento.
    prev_L = [p[1] for p in piv if p[2] == "L" and p[0] < t - ini_p]
    barrido = bool(prev_L) and sl_up < prev_L[-1]
    return dict(puntos=puntos, rompe=puntos >= 1, cierre=cierre * s, sl=sl_up * s, barrido=barrido)


# ---------------- analisis principal ----------------
def _tfs_activas(velas, cfg):
    ct = cfg["temporalidades"]
    return [t for t in velas if t in ct["seleccion"]] if ct["modo"] == "manual" else list(velas)


# memo-v1: en el backtest el mismo DataFrame (misma vela cerrada de un marco) se analiza muchas veces
# seguidas; se guarda el resultado por objeto df para no recalcular pivotes/zonas. Acotado y seguro.
_MEMO = {}


def _memo_get(clave, df, calcular):
    e = _MEMO.get(clave)
    if e is not None and e[0] is df:
        return e[1]
    v = calcular()
    if len(_MEMO) > 200:
        _MEMO.clear()
    _MEMO[clave] = (df, v)
    return v


def analizar(simbolo, velas, cfg=None):
    cfg = cfg or cargar_config()
    ce, ct = cfg["estructura"], cfg["temporalidades"]
    roles = ct["roles"]
    info = {}
    for tf in _tfs_activas(velas, cfg):
        df = velas[tf]
        if len(df) < 60:
            continue
        def _calc(df=df):
            a_ = atr(df, ce["atr_periodo"])
            piv_ = pivotes(df, ce["pivote_k"])
            return a_, piv_, direccion(piv_)
        a, piv, dr = _memo_get(("info", tf, id(df), ce["atr_periodo"], ce["pivote_k"]), df, _calc)
        info[tf] = dict(df=df, atr=a, piv=piv, dir=dr)
    if not info:
        return []

    # 1) direccion global
    cd = cfg["direccion"]
    if cd["modo"] == "manual":
        dg = cd["manual"]
    else:
        votos = [info[t]["dir"] for t in info if t in roles["macro"] + roles["ultra_macro"] and info[t]["dir"] != "acumulacion"]
        if not votos:
            votos = [info[t]["dir"] for t in info if t in roles["intermedio"] and info[t]["dir"] != "acumulacion"]
        dg = max(set(votos), key=votos.count) if votos else "acumulacion"
    if dg == "acumulacion" and not cd["operar_acumulacion"]:
        return []
    if dg == "acumulacion":
        return []
    s = 1 if dg == "alcista" else -1

    # 2) alineacion entre temporalidades
    ali = sum(1 for t in info if info[t]["dir"] == dg) / len(info)     # sin lentes: como antes
    lres, grupos = [], []
    lentes = cfg_lentes(cfg)
    if lentes:
        lres = evaluar_lentes(velas, lentes, info, ce)
        ali_l, grupos = alineacion_lentes(lres, dg, ct["lentes"])
        if ali_l is not None:
            ali = ali_l
    if ct["alineacion"]["usar"] and ali < ct["alineacion"]["minimo"]:
        return []

    # 3) zonas de espera
    cz, cl, cc, co = cfg["zonas_espera"], cfg["liquidez"], cfg["confirmacion"], cfg["operaciones"]
    if not cz["usar"]:
        return []
    zona_tfs = cz["tfs_manual"] if cz["tfs"] == "manual" else roles["intermedio"] + roles["macro"]
    zona_tfs = [t for t in zona_tfs if t in info and info[t]["dir"] == dg]
    micro_tfs = cc["micro_manual"] if cc["micro_tfs"] == "manual" else roles["micro"]
    micro_tfs = [t for t in micro_tfs if t in velas and len(velas[t]) >= 30]
    precio = float((velas[micro_tfs[0]] if micro_tfs else info[list(info)[0]]["df"])["close"].iloc[-1])

    todas = []
    for tf in zona_tfs:
        df, a = info[tf]["df"], info[tf]["atr"]
        def _calc_z(df=df, a=a, tf=tf):
            d = df if s == 1 else _espejo(df)
            piv_d = pivotes(d, ce["pivote_k"])
            imp = _impulso(d, piv_d, ce, a)
            if not imp:
                return None
            zs_, niveles_, hi_, lo_ = _zonas(d, imp, cz)
            pools_ = pools_liquidez(df, info[tf]["piv"], a, cl["tolerancia_atr"]) if cl["usar"] else []
            return imp, zs_, niveles_, hi_, lo_, pools_
        ckey = json.dumps([ce, cz, cl], sort_keys=True, default=str)
        res_z = _memo_get(("zonas", tf, id(df), s, ckey), df, _calc_z)
        if not res_z:
            continue
        imp, zs, niveles, hi, lo, pools = res_z
        for z in zs:
            z = dict(_orig(z, s))
            z.update(tf=tf, atr=a, fuerza=imp["fuerza"], cuerpo_atr=imp["cuerpo_atr"],
                     ext=hi * s, org=lo * s, rng=hi - lo,
                     niveles=[(n, p * s) for n, p in niveles], pools=pools)
            todas.append(z)

    tol_c = cz["tol_confluencia_atr"]
    esc = []
    for z in todas:
        tol = z["atr"] * tol_c
        dist = 0 if z["bajo"] <= precio <= z["alto"] else min(abs(precio - z["bajo"]), abs(precio - z["alto"]))
        if dist > cz["max_distancia_atr"] * z["atr"]:
            continue
        score, motivos = 0, []
        if cfg["confluencias"]["usar"]:
            for o in todas:                                   # zonas de otras temporalidades
                if o is not z and o["tf"] != z["tf"] and o["bajo"] <= z["alto"] + tol and o["alto"] >= z["bajo"] - tol:
                    score += 1
                    motivos.append("%s %s" % (o["tipo"], o["tf"]))
            for n, p in z["niveles"]:                         # nivel 88.6
                if z["bajo"] - tol <= p <= z["alto"] + tol:
                    score += 1
                    motivos.append("nivel %s" % n)
            if ali >= 1.0:
                score += 1
                motivos.append("todas las temporalidades alineadas")
            if grupos:
                mg = max(grupos, key=lambda g: len(g["lentes"]))
                score += 1
                motivos.append("agrupacion de %d lentes en %s (%s)" % (len(mg["lentes"]), mg["fase"], mg["tfs"]))
            if cl["usar"] and cl["como_confluencia"]:
                lado = "L" if s == 1 else "H"
                for p in z["pools"]:
                    if p["tipo"] == lado and p["barrido"] and z["bajo"] - tol <= p["precio"] <= z["alto"] + tol:
                        score += 1
                        motivos.append("liquidez barrida en la zona")
                        break
            if score < cfg["confluencias"]["minimo"]:
                continue

        # estado
        estado = "dentro" if dist == 0 else "esperando"
        nota = []
        if cl["usar"] and cl["evitar_entrada_antes_barrido"]:
            lado = "L" if s == 1 else "H"
            for p in z["pools"]:
                if p["tipo"] == lado and not p["barrido"]:
                    entre = (z["bajo"] - 1.5 * z["atr"] < p["precio"] < z["alto"]) if s == 1 else (z["bajo"] < p["precio"] < z["alto"] + 1.5 * z["atr"])
                    if entre:
                        estado = "esperar_barrido"
                        nota.append("liquidez sin barrer cerca de la zona: mejor esperar el barrido")
                        break
        conf = None
        if cc["usar"] and estado in ("dentro", "esperando"):
            cands = []
            for mt in micro_tfs:
                r = confirmar(velas[mt], z, s, cc)
                if r:
                    r["tf"] = mt
                    cands.append(r)
            req = {"rompimiento": 1, "dos_puntos": 2, "ninguna": 0}[cc["exigir"]]
            ok = [r for r in cands if r["puntos"] >= req]
            if cc.get("exigir_barrido_micro"):
                ok = [r for r in ok if r.get("barrido")]
            if ok:
                conf = min(ok, key=lambda r: abs(r["cierre"] - r["sl"])) if cc["elegir"] == "mejor" else ok[0]
                estado = "confirmada"
                if conf["puntos"] >= 2:
                    score += 1
                    motivos.append("rompimiento de 2 puntos en %s" % conf["tf"])
            elif cands:
                estado = "dentro"
        if z["solo_confirmada"] and estado != "confirmada":
            continue

        # niveles de la operacion
        a = z["atr"]
        buf = co["sl_buffer_atr"] * a
        ent = conf["cierre"] if conf else (z["bajo"] + z["alto"]) / 2
        usar_micro = conf and co["sl_modo"] == "micro_si_confirmada"
        sl = (conf["sl"] - buf if s == 1 else conf["sl"] + buf) if usar_micro else ((z["bajo"] - buf) if s == 1 else (z["alto"] + buf))
        riesgo = abs(ent - sl)
        if riesgo <= 0:
            continue
        tp_c = z["ext"]
        if cl["usar"] and cl["como_tp"]:
            arriba = [p["precio"] for p in z["pools"] if p["tipo"] == ("H" if s == 1 else "L")
                      and not p["barrido"] and (p["precio"] - ent) * s > 0]
            if arriba:
                tp_c = min(arriba, key=lambda x: abs(x - ent))
        if (tp_c - ent) * s <= 0:
            tp_c = z["ext"]
        tp_r = z["ext"] + s * co["correr_extension"] * z["rng"]
        rr_c = abs(tp_c - ent) / riesgo
        if rr_c < co["rr_minimo"]:
            continue
        dos = co["modo"] == "dos" or (co["modo"] == "analisis" and score >= co["score_para_correr"])
        fase_sup = _fase_marco_superior(lres, z["tf"])
        asegurar = bool(co.get("asegurar_en_retroceso")) and fase_sup == "retroceso"
        if asegurar:                                       # marco mayor en retroceso: no correr, asegurar
            nota.append("marco mayor en retroceso: asegurar ganancias (solo TP corto, sin correr)")
            ops = [dict(nombre="corta", tp=tp_c, peso=1.0)]
        elif co["modo"] == "solo_correr":
            ops = [dict(nombre="correr", tp=tp_r, peso=1.0)]
        elif dos and (tp_r - ent) * s > 0:
            w = co["reparto"]
            ops = [dict(nombre="corta", tp=tp_c, peso=w[0]),
                   dict(nombre="correr", tp=tp_r, peso=w[1])]
        else:
            ops = [dict(nombre="corta", tp=tp_c, peso=1.0)]
        for o in ops:
            o["rr"] = round(abs(o["tp"] - ent) / riesgo, 2)
        esc.append(dict(simbolo=simbolo, direccion=dg, estado=estado, zona=z["tipo"], zona_tf=z["tf"],
                        zona_rango=(round(z["bajo"], 2), round(z["alto"], 2)), fuerza_rompimiento=z["fuerza"],
                        entrada=round(ent, 2), sl=round(sl, 2), operaciones=ops, score=score,
                        confluencias=motivos, confirmacion=conf, alineacion=round(ali, 2), notas=nota,
                        fase_marco_superior=fase_sup,
                        lentes=[dict(nombre=r["nombre"], vista=r["vista"], estructura=r["estructura"], dir=r["dir"],
                                     fase=r["fase"], coincide=r["coincide"]) for r in lres],
                        agrupaciones=grupos,
                        _dist=dist / a))
    esc = [e for e in esc if e["estado"] in cfg["avisos"]["estados"]]
    esc.sort(key=lambda e: (-e["score"], e["_dist"]))
    return esc[:cfg["avisos"]["max_escenarios_por_activo"]]


def formato_aviso(e, lotes=None, modo="avisar"):
    """Describe el estado de la senal sin confundir una proyeccion con una orden."""
    ico = "🟢 COMPRA" if e["direccion"] == "alcista" else "🔴 VENTA"
    t = ["%s posible - %s (%s)" % (ico, e["simbolo"], e["estado"]),
         "Zona %s %s: %s - %s | rompimiento %s" % (e["zona"], e["zona_tf"], e["zona_rango"][0], e["zona_rango"][1], e["fuerza_rompimiento"]),
         "Entrada ref: %s | SL: %s" % (e["entrada"], e["sl"])]
    for i, o in enumerate(e["operaciones"]):
        lt = " | lote %s" % lotes[i]["lote"] if lotes and i < len(lotes) else ""
        t.append("%s: TP %.2f (R:R %s)%s" % (o["nombre"], o["tp"], o["rr"], lt))
    if e["confluencias"]:
        t.append("Confluencias (%d): %s" % (e["score"], ", ".join(e["confluencias"])))
    if e.get("lentes"):
        t.append("Lentes: " + " | ".join("%s %s/%s %s %s%s" % (r["nombre"], r["vista"], r["estructura"], r["dir"], r["fase"],
                                                               "" if r["coincide"] else " (contra)") for r in e["lentes"]))
    for g in e.get("agrupaciones") or []:
        t.append("Agrupacion en %s: %s" % (g["fase"], g["tfs"]))
    t += e["notas"]
    if e["estado"] != "confirmada":
        cola = (
            "SENAL SIN CONFIRMAR: no se envio ninguna orden; el bot solo entrara al confirmarse"
            if modo == "auto"
            else "Solo aviso: senal sin confirmar, no es una orden"
        )
    elif modo == "auto":
        cola = "SENAL CONFIRMADA: el modo automatico intentara abrir; el resultado de MT5 se informa aparte"
    else:
        cola = "Senal confirmada; solo aviso, no se envio una orden automatica"
    t.append("Alineacion TF: %d%% | %s." % (int(e["alineacion"] * 100), cola))
    return "\n".join(t)