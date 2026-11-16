import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.analista import api_config
from backend.conexion import conexion_mt5


class AnalistaActivosEstadoTests(unittest.TestCase):
    def test_active_execution_does_not_claim_orders_when_scanner_is_off(self):
        watchlist = {
            "simbolos": ["XAUUSD"],
            "operar": ["XAUUSD"],
            "sufijo": "",
        }
        config = {
            "ejecucion": {
                "activa": True,
                "solo_cuenta_demo": True,
                "max_posiciones_por_simbolo": 1,
                "spread_maximo_puntos": 0,
            }
        }
        symbol_info = SimpleNamespace(trade_mode=4, spread=1)
        fake_mt5 = SimpleNamespace(
            SYMBOL_TRADE_MODE_FULL=4,
            symbol_info=lambda _symbol: symbol_info,
        )

        with (
            patch.object(api_config, "_leer_watch", return_value=watchlist),
            patch.object(api_config, "_leer", return_value=config),
            patch.object(api_config, "_leer_latido", return_value=None),
            patch.object(conexion_mt5, "obtener_info_cuenta", return_value={"es_real": False}),
            patch.object(conexion_mt5, "obtener_posiciones_abiertas", return_value=[]),
            patch.object(conexion_mt5, "_mt5_lock", threading.RLock()),
            patch.object(conexion_mt5, "mt5", fake_mt5),
        ):
            resultado = api_config.estado_activos()

        self.assertEqual(resultado["activos"][0]["estado"], "sin_escaner")
        self.assertEqual(resultado["resumen"]["abriran"], 0)
        self.assertEqual(resultado["resumen"]["con_problema"], 1)


if __name__ == "__main__":
    unittest.main()
