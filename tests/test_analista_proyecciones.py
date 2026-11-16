import io
import json
import threading
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from backend.analista import api_config
from backend.analista import escaner
from backend.conexion import conexion_mt5


class AnalistaProyeccionesTests(unittest.TestCase):
    def setUp(self):
        self.watchlist = {
            "simbolos": ["XAUUSD", "XAGUSD"],
            "operar": ["XAUUSD"],
            "sufijo": "",
            "intervalo_min": 5,
        }
        self.config = {"ejecucion": {"activa": False, "solo_cuenta_demo": True}}

    def test_auto_alert_does_not_claim_an_unconfirmed_signal_was_opened(self):
        escenario = {
            "direccion": "bajista",
            "estado": "dentro",
            "simbolo": "XAGUSD",
            "zona": "FLIP",
            "zona_tf": "H4",
            "zona_rango": (49.69, 50.9),
            "fuerza_rompimiento": "medio",
            "entrada": 50.3,
            "sl": 51.05,
            "operaciones": [{"nombre": "corta", "tp": 48.97, "rr": 1.75}],
            "score": 5,
            "confluencias": [],
            "notas": [],
            "alineacion": 0.67,
        }

        texto = escaner.formato_aviso(escenario, modo="auto")

        self.assertIn("VENTA posible - XAGUSD (dentro)", texto)
        self.assertIn("SENAL SIN CONFIRMAR", texto)
        self.assertIn("no se envio ninguna orden", texto)
        self.assertNotIn("BOT ABRE LAS ORDENES AUTOMATICO", texto)

    def test_alert_summary_lists_followed_and_auto_enabled_assets(self):
        texto = escaner.resumen_activos(
            {"simbolos": ["XAUUSD", "XAGUSD", "USTEC"], "operar": ["XAUUSD", "XAGUSD"]},
            {"ejecucion": {"activa": True}},
        )

        self.assertIn("Seguimiento: XAUUSD, XAGUSD, USTEC", texto)
        self.assertIn("Marcados para operar: XAUUSD, XAGUSD", texto)
        self.assertIn("Apertura automática: XAUUSD, XAGUSD", texto)
        self.assertIn("solo con señal confirmada", texto)

    def test_projection_marks_only_matching_open_spotplus_positions_in_course(self):
        scenario = {
            "simbolo": "XAUUSD",
            "direccion": "bajista",
            "estado": "confirmada",
            "operaciones": [{"nombre": "corta", "tp": 49.0}],
            "lotes": [{"operacion": "corta", "lote": 0.1, "riesgo": 100}],
            "clave": "XAUUSD|bajista|FLIP|H1|50-51",
            "ejecutada": True,
        }
        latido = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "intervalo_min": 5,
            "proyecciones": {"XAUUSD": {"escenarios": [scenario]}},
        }
        posicion = {"tipo": "venta", "comment": "SpotPlus corta"}
        with (
            patch.object(api_config, "_leer_watch", return_value=self.watchlist),
            patch.object(api_config, "_leer", return_value={"ejecucion": {"activa": True}}),
            patch.object(api_config, "_leer_latido", return_value=latido),
            patch.object(conexion_mt5, "obtener_info_cuenta", return_value={"es_real": False}),
            patch.object(conexion_mt5, "obtener_posiciones_abiertas", return_value=[posicion]),
        ):
            resultado = api_config.obtener_proyecciones()

        proyeccion = resultado["activos"][0]["escenarios"][0]
        self.assertTrue(proyeccion["ejecutada"])
        self.assertTrue(proyeccion["en_curso"])

    def test_scanner_status_expires_after_one_interval_and_grace_period(self):
        latido = {
            "ts": (datetime.now() - timedelta(minutes=8)).isoformat(timespec="seconds"),
            "intervalo_min": 5,
        }

        estado = api_config._info_escaner(latido, {"intervalo_min": 5})

        self.assertFalse(estado["corriendo"])

    def test_scanner_console_falls_back_for_unencodable_symbols(self):
        output = io.BytesIO()
        stream = io.TextIOWrapper(output, encoding="cp1252", errors="strict")
        with patch.object(escaner.sys, "stdout", stream):
            escaner._configurar_salida_consola()
            print(chr(0x1F7E2), file=escaner.sys.stdout)
            stream.flush()

        self.assertIn(b"\\U0001f7e2", output.getvalue())

    def test_lists_every_watchlist_asset_when_there_are_no_projections(self):
        latido = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "intervalo_min": 5,
            "proyecciones": {
                "XAUUSD": {"simbolo": "XAUUSD", "mt5": "XAUUSD", "escenarios": []},
                "XAGUSD": {"simbolo": "XAGUSD", "mt5": "XAGUSD", "escenarios": []},
            },
        }
        with (
            patch.object(api_config, "_leer_watch", return_value=self.watchlist),
            patch.object(api_config, "_leer", return_value=self.config),
            patch.object(api_config, "_leer_latido", return_value=latido),
            patch.object(conexion_mt5, "obtener_info_cuenta", return_value={"es_real": False}),
            patch.object(conexion_mt5, "obtener_posiciones_abiertas", return_value=[]),
        ):
            resultado = api_config.obtener_proyecciones()

        self.assertEqual([a["simbolo"] for a in resultado["activos"]], ["XAUUSD", "XAGUSD"])
        self.assertEqual([a["estado"] for a in resultado["activos"]], ["sin_senal", "sin_senal"])
        self.assertTrue(resultado["activos"][0]["marcado_operar"])
        self.assertFalse(resultado["activos"][1]["marcado_operar"])

    def test_explains_when_a_broker_symbol_has_no_candle_data(self):
        watchlist = {
            "simbolos": ["NAS100"],
            "operar": ["NAS100"],
            "sufijo": "",
            "intervalo_min": 5,
        }
        latido = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "intervalo_min": 5,
            "proyecciones": {
                "NAS100": {
                    "mt5": "NAS100",
                    "error": "sin_datos",
                    "escenarios": [],
                }
            },
        }
        with (
            patch.object(api_config, "_leer_watch", return_value=watchlist),
            patch.object(api_config, "_leer", return_value=self.config),
            patch.object(api_config, "_leer_latido", return_value=latido),
            patch.object(conexion_mt5, "obtener_info_cuenta", return_value={"es_real": False}),
            patch.object(conexion_mt5, "obtener_posiciones_abiertas", return_value=[]),
        ):
            resultado = api_config.obtener_proyecciones()

        activo = resultado["activos"][0]
        self.assertEqual(activo["estado"], "sin_datos")
        self.assertIn("NAS100", activo["detalle"])
        self.assertIn("sufijo", activo["detalle"])

    def test_marks_a_new_watchlist_symbol_pending_until_the_next_scan(self):
        watchlist = {"simbolos": ["USTEC"], "operar": ["USTEC"], "sufijo": ""}
        latido = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "intervalo_min": 5,
            "proyecciones": {},
        }
        with (
            patch.object(api_config, "_leer_watch", return_value=watchlist),
            patch.object(api_config, "_leer", return_value=self.config),
            patch.object(api_config, "_leer_latido", return_value=latido),
            patch.object(conexion_mt5, "obtener_info_cuenta", return_value={"es_real": False}),
            patch.object(conexion_mt5, "obtener_posiciones_abiertas", return_value=[]),
        ):
            resultado = api_config.obtener_proyecciones()

        activo = resultado["activos"][0]
        self.assertEqual(activo["estado"], "pendiente")
        self.assertIn("USTEC", activo["detalle"])
        self.assertIn("próximo escaneo", activo["detalle"])

    def test_manual_entry_requires_a_fresh_confirmed_projection(self):
        latido = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "intervalo_min": 5,
            "proyecciones": {},
        }
        with (
            patch.object(api_config, "_leer_watch", return_value=self.watchlist),
            patch.object(api_config, "_leer", return_value=self.config),
            patch.object(api_config, "_leer_latido", return_value=latido),
        ):
            with self.assertRaises(HTTPException) as error:
                api_config.operar_proyeccion({"simbolo": "XAUUSD", "clave": "missing"})

        self.assertEqual(error.exception.status_code, 409)

    def test_scanner_persists_projection_details_for_the_ui(self):
        projection_data = {
            "XAUUSD": {
                "mt5": "XAUUSD",
                "escenarios": [{"estado": "confirmada", "direccion": "alcista"}],
            }
        }
        with tempfile.TemporaryDirectory() as directorio:
            ruta = Path(directorio) / "estado.json"
            with patch.object(escaner, "RUTA_ESTADO", str(ruta)):
                escaner.escribir_estado(
                    {"simbolos": ["XAUUSD"]},
                    {"ejecucion": {"activa": True}},
                    [],
                    {},
                    1,
                    projection_data,
                )
            guardado = json.loads(ruta.read_text(encoding="utf-8"))

        self.assertEqual(guardado["proyecciones"], projection_data)
        self.assertTrue(guardado["ejecucion_activa"])

    def test_manual_entry_works_with_bot_automatic_and_asset_not_marked_operar(self):
        clave = "XAGUSD|bajista|OBC|M15|51-51"
        escenario = {
            "simbolo": "XAGUSD", "direccion": "bajista", "estado": "confirmada",
            "operaciones": [{"nombre": "corta", "tp": 49}],
            "lotes": [{"operacion": "corta", "lote": 0.1}], "clave": clave,
        }
        latido = {
            "ts": datetime.now().isoformat(timespec="seconds"), "intervalo_min": 5,
            "ejecucion_activa": True,
            "proyecciones": {"XAGUSD": {"escenarios": [escenario]}},
        }
        with (
            patch.object(api_config, "_leer_watch", return_value=self.watchlist),
            patch.object(api_config, "_leer", return_value={"ejecucion": {"activa": True}}),
            patch.object(api_config, "_leer_latido", return_value=latido),
            patch.object(conexion_mt5, "obtener_info_cuenta", return_value={"es_real": False}),
            patch("backend.analista.escaner.ejecutar_escenario",
                  return_value=["corta VENTA 0.10 lotes ABIERTA (SL 51.1, TP 49)"]) as ejecutar,
            patch.object(api_config, "_proyecciones_operadas_lock", threading.Lock()),
            patch.object(api_config, "_proyecciones_operadas", set()),
        ):
            resultado = api_config.operar_proyeccion({"simbolo": "XAGUSD", "clave": clave})

        self.assertTrue(resultado["ok"])
        self.assertTrue(ejecutar.call_args.kwargs["manual"])

    def test_manual_entry_is_refused_when_the_bot_already_opened_it(self):
        clave = "XAUUSD|alcista|FLIP|H1|100-101"
        escenario = {"simbolo": "XAUUSD", "estado": "confirmada", "clave": clave, "ejecutada": True}
        latido = {
            "ts": datetime.now().isoformat(timespec="seconds"), "intervalo_min": 5,
            "proyecciones": {"XAUUSD": {"escenarios": [escenario]}},
        }
        with (
            patch.object(api_config, "_leer_watch", return_value=self.watchlist),
            patch.object(api_config, "_leer", return_value=self.config),
            patch.object(api_config, "_leer_latido", return_value=latido),
        ):
            with self.assertRaises(HTTPException) as error:
                api_config.operar_proyeccion({"simbolo": "XAUUSD", "clave": clave})

        self.assertEqual(error.exception.status_code, 409)

    def _escenario_confirmado(self):
        return {
            "simbolo": "XAGUSD", "direccion": "bajista", "estado": "confirmada", "sl": 51.2,
            "operaciones": [{"nombre": "corta", "tp": 49.0}],
        }

    def _correr_ejecutar(self, cfg_ej, manual=False):
        lotes = [{"operacion": "corta", "lote": 0.1}]
        with (
            patch.object(escaner.c, "obtener_posiciones_abiertas", return_value=[]),
            patch.object(escaner.c, "obtener_precio_actual", return_value={"ask": 51.0, "bid": 50.9}),
            patch.object(escaner.c, "enviar_orden_manual", return_value={"ok": True}) as orden,
        ):
            salida = escaner.ejecutar_escenario(
                self._escenario_confirmado(), "XAGUSD", lotes, {"ejecucion": cfg_ej},
                {"es_real": False}, {"operar": ["XAUUSD"], "sufijo": ""}, manual=manual)
        return salida, orden

    def test_auto_skips_assets_not_marked_operar_by_default(self):
        salida, orden = self._correr_ejecutar({"activa": True})
        self.assertIn("no marcado para operar", salida[0])
        orden.assert_not_called()

    def test_auto_takes_every_projection_when_todas_is_on(self):
        salida, orden = self._correr_ejecutar({"activa": True, "todas_las_proyecciones": True})
        self.assertTrue(any(" ABIERTA " in linea for linea in salida))
        orden.assert_called_once()

    def test_manual_pick_ignores_the_operar_mark(self):
        salida, orden = self._correr_ejecutar({"activa": False}, manual=True)
        self.assertTrue(any(" ABIERTA " in linea for linea in salida))
        orden.assert_called_once()

    def test_manual_entry_uses_only_a_confirmed_demo_projection(self):
        clave = "XAUUSD|compra|FLIP|H1|100-101|manual-test"
        escenario = {
            "simbolo": "XAUUSD",
            "direccion": "alcista",
            "estado": "confirmada",
            "operaciones": [{"nombre": "corta", "tp": 105}],
            "lotes": [{"operacion": "corta", "lote": 0.01}],
            "clave": clave,
        }
        latido = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "intervalo_min": 5,
            "proyecciones": {"XAUUSD": {"escenarios": [escenario]}},
        }
        with (
            patch.object(api_config, "_leer_watch", return_value=self.watchlist),
            patch.object(api_config, "_leer", return_value=self.config),
            patch.object(api_config, "_leer_latido", return_value=latido),
            patch.object(conexion_mt5, "obtener_info_cuenta", return_value={"es_real": False}),
            patch(
                "backend.analista.escaner.ejecutar_escenario",
                return_value=["corta COMPRA 0.01 lotes ABIERTA (SL 99, TP 105)"],
            ) as ejecutar,
            patch.object(api_config, "_proyecciones_operadas_lock", threading.Lock()),
            patch.object(api_config, "_proyecciones_operadas", set()),
        ):
            resultado = api_config.operar_proyeccion({"simbolo": "XAUUSD", "clave": clave})

        self.assertTrue(resultado["ok"])
        self.assertEqual(len(resultado["resultados"]), 1)
        self.assertTrue(ejecutar.call_args.kwargs["manual"])


if __name__ == "__main__":
    unittest.main()
