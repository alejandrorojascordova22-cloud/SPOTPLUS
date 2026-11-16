import unittest
from unittest.mock import patch

import pandas as pd

from backend.senales.estructura import be_dinamico


class BreakEvenEstructuralTests(unittest.TestCase):
    def setUp(self):
        self.macro = pd.DataFrame({
            "open": [92],
            "high": [94],
            "low": [90],
            "close": [93],
        })
        self.micro = pd.DataFrame({
            "open": [92, 95, 98, 99, 98, 97, 99, 101],
            "high": [94, 97, 99, 100, 99, 99, 101, 103],
            "low": [90, 94, 96, 97, 96, 96, 98, 100],
            "close": [93, 96, 98, 99, 97, 98, 100, 102],
        })
        self.compra_pivotes = [
            {"indice": 1, "tipo": "low", "precio": 94},
            {"indice": 3, "tipo": "high", "precio": 100},
            {"indice": 5, "tipo": "low", "precio": 96},
        ]
        self.zona_compra = {
            "tipo": "compra",
            "precio": 93,
            "limite_inferior": 90,
            "limite_superior": 95,
        }

    @patch("backend.senales.estructura.detectar_pivotes")
    @patch("backend.senales.estructura._ultima_zona_confirmada_por_tf")
    def test_requires_macro_zone_touch_and_confirmed_micro_impulse_retrace_break(
        self, zona_macro, pivotes
    ):
        zona_macro.return_value = (self.zona_compra, [])
        pivotes.return_value = self.compra_pivotes

        proteger, motivo = be_dinamico(
            {"H4": self.macro, "M1": self.micro},
            "compra",
            precio_apertura=97,
            precio_actual=102,
        )

        self.assertTrue(proteger)
        self.assertEqual(motivo, "zona_H4_impulso_retroceso_bos_M1")

    @patch("backend.senales.estructura.detectar_pivotes")
    @patch("backend.senales.estructura._ultima_zona_confirmada_por_tf")
    def test_waits_for_break_and_for_position_to_be_profitable(self, zona_macro, pivotes):
        zona_macro.return_value = (self.zona_compra, [])
        pivotes.return_value = self.compra_pivotes

        no_ruptura = self.micro.copy()
        no_ruptura.loc[len(no_ruptura) - 1, "close"] = 99
        self.assertEqual(
            be_dinamico(
                {"H4": self.macro, "M1": no_ruptura},
                "compra",
                precio_apertura=97,
                precio_actual=99,
            ),
            (False, None),
        )
        self.assertEqual(
            be_dinamico(
                {"H4": self.macro, "M1": self.micro},
                "compra",
                precio_apertura=103,
                precio_actual=102,
            ),
            (False, None),
        )

    @patch("backend.senales.estructura.detectar_pivotes")
    @patch("backend.senales.estructura._ultima_zona_confirmada_por_tf")
    def test_requires_zone_touch_after_macro_zone_confirmation(self, zona_macro, pivotes):
        zona_macro.return_value = ({
            **self.zona_compra,
            "hora_confirmacion": pd.Timestamp("2026-01-01 00:10:00"),
        }, [])
        pivotes.return_value = self.compra_pivotes
        micro_con_hora = self.micro.copy()
        micro_con_hora["time"] = pd.date_range("2026-01-01", periods=len(micro_con_hora), freq="min")

        self.assertEqual(
            be_dinamico(
                {"H4": self.macro, "M1": micro_con_hora},
                "compra",
                precio_apertura=97,
                precio_actual=102,
            ),
            (False, None),
        )

    @patch("backend.senales.estructura.detectar_pivotes")
    @patch("backend.senales.estructura._ultima_zona_confirmada_por_tf")
    def test_sell_uses_lower_high_and_break_of_first_impulse_low(self, zona_macro, pivotes):
        zona_macro.return_value = ({
            "tipo": "venta",
            "precio": 105,
            "limite_inferior": 103,
            "limite_superior": 108,
        }, [])
        pivotes.return_value = [
            {"indice": 1, "tipo": "high", "precio": 108},
            {"indice": 3, "tipo": "low", "precio": 100},
            {"indice": 5, "tipo": "high", "precio": 105},
        ]
        micro_venta = self.micro.copy()
        micro_venta.loc[0, ["low", "high"]] = [104, 106]
        micro_venta.loc[len(micro_venta) - 1, "close"] = 98

        self.assertEqual(
            be_dinamico(
                {"H4": self.macro, "M1": micro_venta},
                "venta",
                precio_apertura=103,
                precio_actual=98,
            ),
            (True, "zona_H4_impulso_retroceso_bos_M1"),
        )


if __name__ == "__main__":
    unittest.main()
