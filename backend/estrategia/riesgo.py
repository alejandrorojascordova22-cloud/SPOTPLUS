"""Gestion de riesgo configurable (config_estrategia.json -> "riesgo")."""
import math


def dimensionar(cfg_riesgo, balance, entrada, sl, operaciones, valor_por_unidad_lote,
                paso_lote=0.01, lote_min=0.01, lote_max=100.0):
    """
    valor_por_unidad_lote: dinero que gana/pierde 1 lote por cada 1.0 de precio.
      (MT5: info.trade_tick_value / info.trade_tick_size)
    Devuelve una lista con el lote y el riesgo en dinero por cada operacion.
    """
    r = cfg_riesgo
    if r["modo"] == "porcentaje":
        base = balance if r["interes_compuesto"] else r["capital_inicial"]   # compuesto: sobre el balance actual
        riesgo_total = base * r["porcentaje"] / 100.0
    else:                                                                    # monto fijo (no usa compuesto)
        riesgo_total = r["monto_fijo"]
    pesos = [max(0.0, float(op.get("peso", 0) or 0)) for op in operaciones]
    suma_pesos = sum(pesos)
    factor_peso = 1.0 / suma_pesos if suma_pesos > 1.0 else 1.0
    dist = abs(entrada - sl)
    out = []
    for op, peso in zip(operaciones, pesos):
        dinero = riesgo_total * peso * factor_peso
        lote = dinero / (dist * valor_por_unidad_lote) if dist > 0 else 0
        lote = math.floor(lote / paso_lote) * paso_lote
        lote = round(min(lote, lote_max), 8)
        if lote < lote_min:
            out.append(dict(
                operacion=op["nombre"], lote=0, riesgo=0, riesgo_objetivo=round(dinero, 2),
                aviso="riesgo muy chico para el lote minimo",
            ))
        else:
            out.append(dict(
                operacion=op["nombre"], lote=round(lote, 2),
                riesgo=round(lote * dist * valor_por_unidad_lote, 2),
                riesgo_objetivo=round(dinero, 2),
            ))
    return out
