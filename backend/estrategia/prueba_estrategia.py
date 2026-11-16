"""Prueba con datos inventados (solo verifica que corre). Cambia a velas reales de MT5 para usarlo en serio."""
import numpy as np, pandas as pd
from backend.estrategia.estrategia import analizar, cargar_config, formato_aviso
from backend.estrategia.riesgo import dimensionar

def velas_falsas(n, paso, sesgo, semilla):
    rng = np.random.default_rng(semilla)
    c = 2000 + np.cumsum(rng.normal(sesgo, paso, n))
    o = np.r_[c[0], c[:-1]]
    h = np.maximum(o, c) + rng.random(n) * paso
    l = np.minimum(o, c) - rng.random(n) * paso
    return pd.DataFrame(dict(open=o, high=h, low=l, close=c))

if __name__ == "__main__":
    cfg = cargar_config()
    for semilla in range(40):
        v = {"M5": velas_falsas(400, 0.8, 0.05, semilla), "M15": velas_falsas(400, 1.5, 0.1, semilla + 1),
             "H1": velas_falsas(400, 3, 0.3, semilla + 2), "H4": velas_falsas(400, 6, 0.6, semilla + 3),
             "D1": velas_falsas(400, 12, 1.2, semilla + 4)}
        es = analizar("XAUUSD", v, cfg)
        if es:
            e = es[0]
            lotes = dimensionar(cfg["riesgo"], 1000, e["entrada"], e["sl"], e["operaciones"], 100)
            print(formato_aviso(e, lotes))
            break
    else:
        print("Sin escenarios en datos inventados (normal); la prueba corrio sin errores.")
