import os
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest
from fastapi import HTTPException

from backend.vivo.lentes import _marcas_estructura_historica

os.environ.setdefault("API_KEY", "test-key")


class TestLentesHistoricos(unittest.TestCase):
    def test_pivote_se_muestra_al_confirmarse_y_quiebre_no_usa_velas_futuras(self):
        df = pd.DataFrame({
            "time": list(range(7)),
            "high": [1, 2, 5, 4, 4, 4, 6],
            "low": [0, 1, 2, 1, 0, 1, 2],
            "close": [1, 2, 4, 3, 2, 6, 5],
        })

        pivotes, quiebres = _marcas_estructura_historica(df, 1, "alcista")

        pivote_alto = next(p for p in pivotes if p["tipo"] == "high")
        self.assertEqual(pivote_alto["time"], 2)
        self.assertEqual(pivote_alto["confirmacion"], 3)
        quiebre_alto = next(q for q in quiebres if q["direccion"] == "alcista")
        self.assertEqual(quiebre_alto["time"], 5)

    def test_api_replay_entrega_lentes_historicos_configurados(self):
        from backend import servidor

        config = {
            "temporalidades": {
                "lentes": {
                    "usar": True,
                    "lista": [{"nombre": "micro", "vista": "M5", "estructura": "M1"}],
                },
            },
            "estructura": {"pivote_k": 1},
        }
        tiempos = pd.date_range("2026-01-01", periods=100, freq="min")
        x = np.arange(100)
        cierres = 100 + x * 0.02 + np.sin(x / 3)
        velas = pd.DataFrame({
            "time": tiempos,
            "open": cierres,
            "high": cierres + 0.5,
            "low": cierres - 0.5,
            "close": cierres,
        })
        llamadas = []

        def velas_falsas(simbolo, desde, hasta, tf):
            llamadas.append((simbolo, tf))
            return velas.copy(), "prueba"

        with patch.object(servidor, "cargar_config_analista", return_value=config), patch.object(
            servidor, "_velas_backtest", side_effect=velas_falsas,
        ):
            resultado = servidor.get_lentes_replay_backtest(
                desde="2026-01-01", hasta="2026-02-01", simbolo="XAUUSD",
            )

        self.assertEqual([l["nombre"] for l in resultado["lentes"]], ["micro"])
        self.assertTrue(resultado["lentes"][0]["pivotes"])
        self.assertTrue(all(
            p["confirmacion"] > p["time"] for p in resultado["lentes"][0]["pivotes"]
        ))
        self.assertEqual(set(llamadas), {("XAUUSD", "M5"), ("XAUUSD", "M1")})

    def test_api_replay_rechaza_fechas_invalidas(self):
        from backend import servidor

        with pytest.raises(HTTPException) as error:
            servidor.get_lentes_replay_backtest(
                desde="ayer", hasta="2026-02-01", simbolo="XAUUSD",
            )

        assert error.value.status_code == 400


if __name__ == "__main__":
    unittest.main()
