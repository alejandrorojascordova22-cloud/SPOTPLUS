import unittest
from unittest.mock import patch

import pandas as pd

from backend.analista.backtest_analista import _buscar_cierre, simular_backtest_analista, timeframe_replay
from backend.estrategia.riesgo import dimensionar


class BacktestAnalistaTests(unittest.TestCase):
    def setUp(self):
        tiempos = pd.date_range("2025-12-31 23:40:00", periods=12, freq="5min")
        self.velas = pd.DataFrame({
            "time": tiempos,
            "open": [100] * 12,
            "high": [101] * 7 + [103] * 5,
            "low": [99] * 7 + [100] * 5,
            "close": [100] * 4 + [100, 100, 100, 101, 102, 102, 102, 102],
        })
        self.config = {
            "temporalidades": {"modo": "manual", "seleccion": ["M5"], "roles": {}},
            "riesgo": {
                "modo": "porcentaje",
                "porcentaje": 1,
                "interes_compuesto": True,
                "capital_inicial": 10000,
                "monto_fijo": 10,
            },
        }

    def test_selects_replay_frame_at_or_above_scan_interval(self):
        self.assertEqual(timeframe_replay(["M1", "M3", "M5"], 5), "M5")
        self.assertEqual(timeframe_replay(["M1", "M3"], 5), "M1")

    def test_sell_stop_fills_at_stop_or_gap_open(self):
        posicion = {"tipo": "venta", "sl": 4525.22, "tp": 4500, "be_aplicado": False}
        vela_sin_gap = pd.Series({"open": 4524.0, "high": 4526.0, "low": 4523.0, "close": 4525.0})
        vela_con_gap = pd.Series({"open": 4527.0, "high": 4528.0, "low": 4526.0, "close": 4527.5})

        self.assertEqual(_buscar_cierre(posicion, vela_sin_gap), (4525.22, "sl"))
        self.assertEqual(_buscar_cierre(posicion, vela_con_gap, gap_realista=True), (4527.0, "sl"))
        # Por defecto el SL cierra exacto: la pérdida no se pasa del riesgo.
        self.assertEqual(_buscar_cierre(posicion, vela_con_gap), (4525.22, "sl"))

    def test_gap_can_make_realized_loss_exceed_sized_stop_risk(self):
        self._correr_con_gap(gap_realista=True)

    def test_sl_respects_configured_risk_by_default_even_with_gap(self):
        resultado = self._correr_con_gap(gap_realista=False)
        operacion = resultado["operaciones"][0]
        self.assertEqual(operacion["salida"], 102)
        self.assertEqual(operacion["profit"], -100)

    def _correr_con_gap(self, gap_realista):
        velas = self.velas.copy()
        velas.loc[7, ["open", "high", "low", "close"]] = [105, 106, 104, 105]

        def fake_analyze(simbolo, historico, config):
            latest = historico["M5"]["time"].iloc[-1]
            if latest < pd.Timestamp("2026-01-01 00:10:00"):
                return []
            return [{
                "direccion": "bajista",
                "zona": "FLIP",
                "zona_tf": "M5",
                "zona_rango": (99.5, 100.5),
                "entrada": 100,
                "sl": 102,
                "operaciones": [{"nombre": "corta", "tp": 90, "peso": 1}],
            }]

        config = {**self.config, "riesgo": {**self.config["riesgo"], "gap_realista": gap_realista}}
        resultado = simular_backtest_analista(
            {"M5": velas},
            config,
            "XAUUSD",
            "2026-01-01",
            "2026-01-01",
            10000,
            valor_por_unidad_lote=10,
            analizar_fn=fake_analyze,
        )

        if gap_realista:
            operacion = resultado["operaciones"][0]
            self.assertEqual(operacion["salida"], 105)
            self.assertEqual(operacion["riesgo_objetivo"], 100)
            self.assertEqual(operacion["riesgo_real"], 100)
            self.assertEqual(operacion["profit"], -250)
            self.assertGreater(abs(operacion["profit"]), operacion["riesgo_real"])
        return resultado

    def test_risk_allocation_never_exceeds_budget_when_weights_are_too_large(self):
        lotes = dimensionar(
            {"modo": "monto_fijo", "monto_fijo": 100},
            1000,
            100,
            98,
            [
                {"nombre": "corta", "peso": 0.7},
                {"nombre": "correr", "peso": 0.7},
            ],
            10,
        )

        self.assertAlmostEqual(sum(lote["riesgo_objetivo"] for lote in lotes), 100)
        self.assertLessEqual(sum(lote["riesgo"] for lote in lotes), 100)

    def test_uses_closed_candles_and_draws_the_analyst_trade(self):
        max_seen = []

        def fake_analyze(simbolo, velas, config):
            self.assertEqual(simbolo, "XAUUSD")
            latest = velas["M5"]["time"].iloc[-1]
            tiempo_actual = self.velas["time"].iloc[4 + len(max_seen)]
            self.assertLessEqual(latest, tiempo_actual)
            max_seen.append(latest)
            if latest < pd.Timestamp("2026-01-01 00:10:00"):
                return []
            return [{
                "direccion": "alcista",
                "zona": "FLIP",
                "zona_tf": "M5",
                "zona_rango": (99.5, 100.5),
                "fuerza_rompimiento": "fuerte",
                "entrada": 100,
                "sl": 98,
                "operaciones": [{"nombre": "corta", "tp": 102, "peso": 1}],
            }]

        resultado = simular_backtest_analista(
            {"M5": self.velas},
            self.config,
            "XAUUSD",
            "2026-01-01",
            "2026-01-01",
            10000,
            valor_por_unidad_lote=10,
            analizar_fn=fake_analyze,
        )

        self.assertEqual(resultado["diagnostico"]["estrategia_activa"], "Panel Analista")
        self.assertEqual(resultado["total_operaciones"], 1)
        operacion = resultado["operaciones"][0]
        self.assertEqual(operacion["tipo"], "compra")
        self.assertEqual(operacion["motivo_cierre"], "tp")
        self.assertEqual(operacion["profit"], 100)
        self.assertEqual(operacion["riesgo_objetivo"], 100)
        self.assertEqual(operacion["riesgo_real"], 100)
        self.assertGreater(resultado["indice_inicio_replay"], 0)
        self.assertTrue(max_seen)
        pasos = resultado["pasos_estrategia"]
        self.assertTrue(any("Dirección alcista" in paso["texto"] for paso in pasos))
        self.assertTrue(any("Rompimiento fuerte" in paso["texto"] for paso in pasos))
        self.assertTrue(any(paso["tipo"] == "entrada" for paso in pasos))
        self.assertTrue(any("Cierre TP" in paso["texto"] for paso in pasos))
        self.assertTrue(all(isinstance(paso["time"], int) for paso in pasos))

    def test_exposes_open_trade_and_risk_at_end_of_replay(self):
        def fake_analyze(simbolo, velas, config):
            latest = velas["M5"]["time"].iloc[-1]
            if latest < pd.Timestamp("2026-01-01 00:10:00"):
                return []
            return [{
                "direccion": "alcista",
                "zona": "FLIP",
                "zona_tf": "M5",
                "zona_rango": (99.5, 100.5),
                "entrada": 100,
                "sl": 98,
                "operaciones": [{"nombre": "corta", "tp": 105, "peso": 1}],
            }]

        resultado = simular_backtest_analista(
            {"M5": self.velas},
            self.config,
            "XAUUSD",
            "2026-01-01",
            "2026-01-01",
            10000,
            valor_por_unidad_lote=10,
            analizar_fn=fake_analyze,
        )

        self.assertEqual(resultado["total_operaciones"], 0)
        self.assertEqual(len(resultado["posiciones_abiertas"]), 1)
        abierta = resultado["posiciones_abiertas"][0]
        self.assertEqual(abierta["riesgo_objetivo"], 100)
        self.assertEqual(abierta["riesgo_real"], 100)
        self.assertEqual(abierta["riesgo_actual"], 100)
        self.assertEqual(abierta["profit_flotante"], 100)
        self.assertEqual(resultado["posicion_abierta_al_final"], abierta)

    def test_counts_breakeven_separately_from_losses(self):
        velas = self.velas.copy()
        velas["low"] = velas["low"].astype(float)
        velas.loc[7, "low"] = 100.5

        def fake_analyze(simbolo, velas, config):
            latest = velas["M5"]["time"].iloc[-1]
            if latest < pd.Timestamp("2026-01-01 00:10:00"):
                return []
            return [{
                "direccion": "alcista",
                "estado": "confirmada",
                "zona": "FLIP",
                "zona_tf": "M5",
                "zona_rango": (99.5, 100.5),
                "entrada": 100,
                "sl": 98,
                "operaciones": [
                    {"nombre": "corta", "tp": 102, "peso": 0.5},
                    {"nombre": "correr", "tp": 105, "peso": 0.5},
                ],
            }]

        def be_confirmado(**kwargs):
            velas_micro = kwargs["velas_por_temporalidad"].get("M5")
            activado = (
                velas_micro is not None
                and velas_micro["time"].iloc[-1] >= pd.Timestamp("2026-01-01 00:15:00")
            )
            return (activado, "estructura" if activado else None)

        with patch("backend.analista.backtest_analista.be_dinamico", side_effect=be_confirmado):
            resultado = simular_backtest_analista(
                {"M5": velas},
                self.config,
                "XAUUSD",
                "2026-01-01",
                "2026-01-01",
                10000,
                valor_por_unidad_lote=10,
                analizar_fn=fake_analyze,
            )

        self.assertEqual(resultado["total_operaciones"], 2)
        self.assertEqual(resultado["ganadoras"], 1)
        self.assertEqual(resultado["perdedoras"], 0)
        self.assertEqual(resultado["neutras"], 1)
        self.assertEqual(resultado["ganadoras"] + resultado["perdedoras"] + resultado["neutras"], 2)
        self.assertEqual(resultado["tasa_acierto"], 50.0)


if __name__ == "__main__":
    unittest.main()