import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.conexion import conexion_mt5
from backend.conexion import conexion_mt5 as conexion_mt5_api


class CandadoMT5Tests(unittest.TestCase):
    def test_nested_mt5_calls_share_the_same_process_lock(self):
        with patch.object(conexion_mt5, "_bloqueo_proceso_mt5") as bloqueo:
            @conexion_mt5._con_candado
            def llamada_interna():
                return "ok"

            @conexion_mt5._con_candado
            def llamada_externa():
                return llamada_interna()

            self.assertEqual(llamada_externa(), "ok")

        bloqueo.assert_called_once_with()


class CopiarVelasTests(unittest.TestCase):
    @patch.object(conexion_mt5.mt5, "copy_rates_from_pos")
    @patch.object(conexion_mt5.mt5, "symbol_select")
    def test_selecciona_el_simbolo_antes_de_pedir_velas(self, seleccionar, copiar):
        eventos = []
        seleccionar.side_effect = lambda *args: eventos.append("seleccionar") or True
        copiar.side_effect = lambda *args: eventos.append("copiar") or [{"time": 1}]

        velas = conexion_mt5._copiar_velas("XAUUSD", 5, 200)

        self.assertEqual(velas, [{"time": 1}])
        self.assertEqual(eventos, ["seleccionar", "copiar"])
        seleccionar.assert_called_once_with("XAUUSD", True)

    @patch.object(conexion_mt5.mt5, "copy_rates_from_pos")
    @patch.object(conexion_mt5.mt5, "symbol_select", return_value=False)
    def test_no_consulta_velas_si_no_puede_seleccionar_el_simbolo(self, seleccionar, copiar):
        with patch.object(conexion_mt5.mt5, "last_error", return_value=(-1, "symbol unavailable")):
            velas = conexion_mt5._copiar_velas("NOEXISTE", 5, 200)

        self.assertIsNone(velas)
        seleccionar.assert_called_once_with("NOEXISTE", True)
        copiar.assert_not_called()

    @patch.object(conexion_mt5.mt5, "copy_rates_from_pos", return_value=[])
    @patch.object(conexion_mt5.mt5, "symbol_select", return_value=True)
    def test_trata_una_respuesta_sin_velas_como_fallo(self, seleccionar, copiar):
        velas = conexion_mt5._copiar_velas("XAUUSD", 5, 200)

        self.assertIsNone(velas)
        seleccionar.assert_called_once_with("XAUUSD", True)
        copiar.assert_called_once_with("XAUUSD", 5, 0, 200)


class RetcodeTests(unittest.TestCase):
    def setUp(self):
        # Esta prueba revisa SOLO como se traduce el retcode de MT5. La guardia de riesgo
        # (kill switch, SL obligatorio, perdida diaria...) lee tu guardia_riesgo.json y tu
        # MT5 real, asi que se aisla para que el resultado no dependa de tu estado local.
        parche = patch("backend.operaciones.guardia_riesgo.revisar_orden", return_value=None)
        parche.start()
        self.addCleanup(parche.stop)

    @patch.object(
        conexion_mt5.mt5,
        "order_send",
        return_value=SimpleNamespace(retcode=10027, comment="AutoTrading disabled by client"),
    )
    @patch.object(
        conexion_mt5.mt5,
        "symbol_info_tick",
        return_value=SimpleNamespace(ask=100.1, bid=100.0),
    )
    @patch.object(
        conexion_mt5.mt5,
        "symbol_info",
        return_value=SimpleNamespace(
            visible=True,
            digits=2,
            point=0.01,
            trade_stops_level=0,
        ),
    )
    def test_client_disabled_autotrading_returns_actionable_message_without_retries(
        self, simbolo_info, tick, enviar
    ):
        resultado = conexion_mt5.enviar_orden_manual("compra", 0.01, simbolo="XAUUSD")

        self.assertFalse(resultado["ok"])
        self.assertEqual(resultado["retcode"], 10027)
        self.assertIn("activa", resultado["error"])
        self.assertIn("Algo Trading", resultado["error"])
        self.assertIn("SpotPlus no puede activar", resultado["error"])
        enviar.assert_called_once()


class ModificarSlMasivoTests(unittest.TestCase):
    @patch.object(
        conexion_mt5_api.mt5,
        "order_send",
        side_effect=[
            SimpleNamespace(retcode=conexion_mt5_api.mt5.TRADE_RETCODE_DONE),
            SimpleNamespace(retcode=10025),
        ],
    )
    @patch.object(conexion_mt5_api.mt5, "positions_get")
    def test_consults_open_positions_once_and_preserves_live_take_profits(
        self, posiciones, enviar
    ):
        posiciones.return_value = [
            SimpleNamespace(ticket=11, symbol="XAUUSD", tp=105.0),
            SimpleNamespace(ticket=12, symbol="EURUSD", tp=1.2),
        ]

        resultado = conexion_mt5_api.modificar_sl_masivo([
            {"ticket": 11, "precio_apertura": 100.0},
            {"ticket": 12, "precio_apertura": 1.1},
        ])

        self.assertEqual(resultado, {
            11: {"ok": True},
            12: {"ok": True, "sin_cambios": True},
        })
        posiciones.assert_called_once_with()
        self.assertEqual(enviar.call_count, 2)
        self.assertEqual(enviar.call_args_list[0].args[0]["tp"], 105.0)
        self.assertEqual(enviar.call_args_list[1].args[0]["tp"], 1.2)

    @patch.object(conexion_mt5_api.mt5, "order_send")
    @patch.object(conexion_mt5_api.mt5, "positions_get", return_value=[])
    def test_reports_positions_that_closed_before_batch_update(self, posiciones, enviar):
        resultado = conexion_mt5_api.modificar_sl_masivo([
            {"ticket": 11, "precio_apertura": 100.0},
        ])

        self.assertEqual(resultado[11], {
            "ok": False,
            "error": "Posición no encontrada",
        })
        posiciones.assert_called_once_with()
        enviar.assert_not_called()

    @patch.object(conexion_mt5_api.time, "sleep")
    @patch.object(
        conexion_mt5_api.mt5,
        "order_send",
        side_effect=[
            SimpleNamespace(retcode=10024, comment="too many requests"),
            SimpleNamespace(retcode=conexion_mt5_api.mt5.TRADE_RETCODE_DONE),
        ],
    )
    @patch.object(conexion_mt5_api.mt5, "positions_get")
    def test_retries_transient_rate_limit(self, posiciones, enviar, pausa):
        posiciones.return_value = [
            SimpleNamespace(ticket=11, symbol="XAUUSD", tp=105.0),
        ]

        resultado = conexion_mt5_api.modificar_sl_masivo([
            {"ticket": 11, "precio_apertura": 100.0},
        ])

        self.assertEqual(resultado, {11: {"ok": True}})
        self.assertEqual(enviar.call_count, 2)
        self.assertEqual(pausa.call_args_list[0].args, (0.5,))


class ObtenerPosicionesAbiertasTests(unittest.TestCase):
    @patch.object(conexion_mt5_api.mt5, "last_error", return_value=(-1, "No IPC connection"))
    @patch.object(conexion_mt5_api.mt5, "positions_get", return_value=None)
    def test_raises_query_error_instead_of_reporting_no_positions(self, posiciones, error):
        with self.assertRaisesRegex(RuntimeError, "No IPC connection"):
            conexion_mt5_api.obtener_posiciones_abiertas(simbolo=None)

        posiciones.assert_called_once_with()
        error.assert_called_once_with()


class GestionPosicionesGrupalesTests(unittest.TestCase):
    def setUp(self):
        self.compra = SimpleNamespace(
            ticket=101,
            symbol="XAUUSD",
            type=conexion_mt5_api.mt5.POSITION_TYPE_BUY,
            price_open=100.0,
            sl=99.0,
        )
        self.venta = SimpleNamespace(
            ticket=202,
            symbol="XAUUSD",
            type=conexion_mt5_api.mt5.POSITION_TYPE_SELL,
            price_open=100.0,
            sl=101.0,
        )

    def consultar_posiciones(self, **filtros):
        return [
            posicion
            for posicion in (self.compra, self.venta)
            if all(getattr(posicion, campo) == valor for campo, valor in filtros.items())
        ]

    @patch.object(conexion_mt5_api, "modificar_sl", return_value={"ok": True})
    @patch.object(conexion_mt5_api.mt5, "symbol_info_tick", return_value=SimpleNamespace(bid=101.0, ask=101.1))
    @patch.object(
        conexion_mt5_api.mt5,
        "symbol_info",
        return_value=SimpleNamespace(point=0.01, digits=2, trade_stops_level=0, trade_freeze_level=0),
    )
    @patch.object(conexion_mt5_api.mt5, "positions_get")
    def test_mueve_sl_solo_a_las_compras_del_simbolo_y_aplica_colchon(
        self, posiciones, informacion, tick, modificar
    ):
        posiciones.side_effect = self.consultar_posiciones

        resultado = conexion_mt5_api.gestionar_posiciones("XAUUSD", "compra", "mover_sl", 20)

        self.assertTrue(resultado["ok"])
        self.assertEqual(resultado["total"], 1)
        modificar.assert_called_once_with(101, 100.2)

    @patch.object(conexion_mt5_api, "modificar_sl", return_value={"ok": True})
    @patch.object(conexion_mt5_api.mt5, "symbol_info_tick", return_value=SimpleNamespace(bid=99.4, ask=99.5))
    @patch.object(
        conexion_mt5_api.mt5,
        "symbol_info",
        return_value=SimpleNamespace(point=0.01, digits=2, trade_stops_level=0, trade_freeze_level=0),
    )
    @patch.object(conexion_mt5_api.mt5, "positions_get")
    def test_mueve_sl_de_ventas_hacia_abajo_con_colchon(
        self, posiciones, informacion, tick, modificar
    ):
        posiciones.side_effect = self.consultar_posiciones

        resultado = conexion_mt5_api.gestionar_posiciones("XAUUSD", "venta", "mover_sl", 10)

        self.assertTrue(resultado["ok"])
        modificar.assert_called_once_with(202, 99.9)

    @patch.object(conexion_mt5_api, "modificar_sl")
    @patch.object(conexion_mt5_api.mt5, "symbol_info_tick", return_value=SimpleNamespace(bid=100.1, ask=100.2))
    @patch.object(
        conexion_mt5_api.mt5,
        "symbol_info",
        return_value=SimpleNamespace(point=0.01, digits=2, trade_stops_level=0, trade_freeze_level=0),
    )
    @patch.object(conexion_mt5_api.mt5, "positions_get")
    def test_omite_sl_si_el_precio_no_permite_colocar_el_colchon(
        self, posiciones, informacion, tick, modificar
    ):
        posiciones.side_effect = self.consultar_posiciones

        resultado = conexion_mt5_api.gestionar_posiciones("XAUUSD", "compra", "mover_sl", 20)

        self.assertEqual(resultado["omitidas"][0]["ticket"], 101)
        modificar.assert_not_called()

    @patch.object(conexion_mt5_api, "modificar_sl")
    @patch.object(conexion_mt5_api.mt5, "symbol_info_tick", return_value=SimpleNamespace(bid=101.0, ask=101.1))
    @patch.object(
        conexion_mt5_api.mt5,
        "symbol_info",
        return_value=SimpleNamespace(point=0.01, digits=2, trade_stops_level=0, trade_freeze_level=0),
    )
    @patch.object(conexion_mt5_api.mt5, "positions_get")
    def test_no_afloja_un_sl_compra_que_ya_protege_mejor(
        self, posiciones, informacion, tick, modificar
    ):
        self.compra.sl = 100.3
        posiciones.side_effect = self.consultar_posiciones

        resultado = conexion_mt5_api.gestionar_posiciones("XAUUSD", "compra", "mover_sl", 20)

        self.assertIn("ya protege igual o mejor", resultado["omitidas"][0]["motivo"])
        modificar.assert_not_called()

    @patch.object(conexion_mt5_api, "cerrar_posicion", return_value={"ok": True})
    @patch.object(conexion_mt5_api.mt5, "positions_get")
    def test_cierra_unicamente_el_lado_seleccionado(self, posiciones, cerrar):
        posiciones.side_effect = self.consultar_posiciones

        resultado = conexion_mt5_api.gestionar_posiciones("XAUUSD", "venta", "cerrar")

        self.assertTrue(resultado["ok"])
        cerrar.assert_called_once_with(202)


class AccountModeTests(unittest.TestCase):
    def test_demo_and_real_modes_are_reported_correctly_by_both_connectors(self):
        connectors = (conexion_mt5, conexion_mt5_api)
        expected = (
            (0, False),
            (1, False),
            (2, True),
        )

        for connector in connectors:
            for trade_mode, es_real in expected:
                with self.subTest(module=connector.__name__, trade_mode=trade_mode):
                    account = SimpleNamespace(
                        login=123,
                        server="Broker-Demo",
                        balance=100.0,
                        equity=100.0,
                        profit=0.0,
                        margin_free=100.0,
                        leverage=100,
                        currency="USD",
                        trade_mode=trade_mode,
                    )
                    with patch.object(connector.mt5, "account_info", return_value=account):
                        info = connector.obtener_info_cuenta()

                    self.assertEqual(info["es_real"], es_real)


if __name__ == "__main__":
    unittest.main()