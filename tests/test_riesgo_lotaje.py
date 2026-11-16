"""Gestion de riesgo: misma perdida por operacion sin importar activo/SL,
lotes validos del broker y omision si el minimo se pasa del riesgo."""
import pandas as pd

from backend.operaciones.riesgo import dimensionar_lote, riesgo_configurado
from backend.operaciones.backtesting import simular_backtest

LIM = dict(paso=0.01, minimo=0.01, maximo=50.0)


def test_riesgo_igual_en_distintos_activos_y_sl():
    # (valor por unidad de precio, distancia SL): forex, JPY, oro
    casos = [(100000.0, 0.0020), (6400.0, 0.20), (100.0, 6.0), (100000.0, 0.0050)]
    for valor_u, dist in casos:
        r = dimensionar_lote(100.0, dist, valor_u, **LIM)
        assert r["operable"]
        # nunca pasa de 100; solo baja por el redondeo al paso (maximo 1 paso de lote)
        assert 100.0 - dist * valor_u * LIM["paso"] - 1e-6 <= r["riesgo_real"] <= 100.0


def test_nunca_se_pasa_por_redondeo():
    r = dimensionar_lote(100.0, 0.0017, 100000.0, **LIM)
    assert r["riesgo_real"] <= 100.0


def test_minimo_del_broker_omite_la_operacion():
    r = dimensionar_lote(2.0, 0.0050, 100000.0, **LIM)    # 0.01 lote = 5 > 2
    assert r["operable"] is False and r["lotaje"] == 0.0
    r = dimensionar_lote(2.0, 0.0050, 100000.0, permitir_minimo=True, **LIM)
    assert r["operable"] is True and r["lotaje"] == 0.01


def test_maximo_del_broker_reduce_riesgo():
    r = dimensionar_lote(10000.0, 0.0010, 100000.0, paso=0.01, minimo=0.01, maximo=5.0)
    assert r["lotaje"] == 5.0 and r["riesgo_real"] < 10000.0


def test_riesgo_configurado_prioridades():
    assert riesgo_configurado({"modo_riesgo": "lote_fijo"}) is None
    assert riesgo_configurado({"modo_riesgo": "porcentaje", "riesgo_valor": 1}) == ("porcentaje", 1.0)
    assert riesgo_configurado({"modo_riesgo": "monto_fijo", "riesgo_valor": 50}) == ("fijo", 50.0)
    assert riesgo_configurado({"modo_riesgo": "porcentaje", "riesgo_valor": 1}, valor_senal=0.5) == ("porcentaje", 0.5)
    cfg = {"modo_riesgo": "monto_fijo", "riesgo_valor": 50, "riesgo_total_activo": True,
           "riesgo_total_pct": 1.0, "max_operaciones_por_simbolo": 2}
    assert riesgo_configurado(cfg, 1) == ("porcentaje", 0.5)


def _velas():
    n = 400
    precios = [1.1000 + 0.0001 * i + (0.0004 if i % 7 == 0 else 0) for i in range(n)]
    return pd.DataFrame({
        "time": pd.date_range("2026-01-01", periods=n, freq="15min"),
        "open": precios, "high": [p + 0.0003 for p in precios],
        "low": [p - 0.0003 for p in precios], "close": precios,
    })


def _senales_con_sl_distinto(monkeypatch):
    """Cada 15 velas manda una compra; el SL alterna 10 y 50 pips (1 pip = 0.0001)."""
    import backend.operaciones.backtesting as bt

    def falsa(ventana, config, ventana_macro=None, velas_tf=None):
        n = len(ventana)
        if n % 15 != 0:
            return None
        cierre = float(ventana.iloc[-1]["close"])
        dist = 0.0010 if (n // 15) % 2 == 0 else 0.0050
        return {"tipo": "compra", "precio_entrada": cierre, "sl": cierre - dist,
                "tp": cierre + 2 * dist, "id": n}

    monkeypatch.setattr(bt, "_calcular_senal", falsa)


def test_backtest_arriesga_lo_mismo_con_cualquier_sl(monkeypatch):
    _senales_con_sl_distinto(monkeypatch)
    cfg = {"modo_riesgo": "monto_fijo", "riesgo_valor": 100.0, "volumen_operacion": 0.5}
    res = simular_backtest(_velas(), cfg, contrato=100000.0, valor_por_unidad=100000.0,
                           limites_lote=LIM)
    ops = res["operaciones"]
    assert len(ops) >= 3
    distancias = set()
    for t in ops:
        dist = round(abs(t["entrada"] - t["sl"]), 4)
        distancias.add(dist)
        riesgo = t["volumen"] * dist * 100000.0
        assert 100.0 - dist * 100000.0 * LIM["paso"] - 1e-6 <= riesgo <= 100.0 + 1e-6
    assert len(distancias) >= 2          # de verdad hubo SL distintos
    assert res["diagnostico"] is not None


def test_backtest_omite_si_el_minimo_se_pasa_del_riesgo(monkeypatch):
    _senales_con_sl_distinto(monkeypatch)
    # riesgo de 5: con SL de 50 pips el lote minimo (0.01) arriesgaria 5 -> pasa; con 10 pips 1 -> pasa.
    # riesgo de 0.5: ninguno entra con el minimo.
    cfg = {"modo_riesgo": "monto_fijo", "riesgo_valor": 0.5, "volumen_operacion": 0.5}
    res = simular_backtest(_velas(), cfg, contrato=100000.0, valor_por_unidad=100000.0,
                           limites_lote=LIM)
    assert res["total_operaciones"] == 0
    assert res["diagnostico"]["operaciones_omitidas_por_riesgo"] >= 4


def test_backtest_sin_limites_mantiene_volumen_fijo(monkeypatch):
    _senales_con_sl_distinto(monkeypatch)
    cfg = {"modo_riesgo": "monto_fijo", "riesgo_valor": 100.0, "volumen_operacion": 0.05}
    res = simular_backtest(_velas(), cfg, contrato=100000.0)
    assert len(res["operaciones"]) >= 3
    assert all(t["volumen"] == 0.05 for t in res["operaciones"])


def test_backtest_aplica_be_estructural_desde_la_vela_siguiente(monkeypatch):
    import backend.operaciones.backtesting as bt

    tiempos = pd.date_range("2026-01-01", periods=8, freq="5min")
    velas = pd.DataFrame({
        "time": tiempos,
        "open": [100.0] * 8,
        "high": [101.0] * 8,
        "low": [99.0, 99.0, 99.0, 99.0, 99.0, 100.0, 99.0, 99.0],
        "close": [100.0] * 8,
    })
    velas_m1 = pd.DataFrame({
        "time": pd.date_range("2026-01-01", periods=40, freq="min"),
        "open": [100.0] * 40,
        "high": [101.0] * 40,
        "low": [99.0] * 40,
        "close": [100.0] * 40,
    })

    def senal_una_vez(ventana, _config, _ventana_macro=None, _velas_tf=None):
        if len(ventana) == 4:
            return {"tipo": "compra", "precio_entrada": 100, "sl": 90, "tp": 110, "id": "setup"}
        return None

    monkeypatch.setattr(bt, "_calcular_senal", senal_una_vez)
    monkeypatch.setattr(bt, "be_dinamico", lambda **_kwargs: (True, "estructura"))
    resultado = bt.simular_backtest(
        velas,
        {"timeframe_entrada": "M5", "volumen_operacion": 1.0},
        ventana_minima=3,
        dfs_tf={"M1": velas_m1},
    )

    assert resultado["operaciones"][0]["motivo_cierre"] == "be"
    assert resultado["operaciones"][0]["be_aplicado"] is True
    assert resultado["operaciones"][0]["hora_cierre"] == str(tiempos[5])
