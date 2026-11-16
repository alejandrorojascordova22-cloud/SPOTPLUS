import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

from backend.notificaciones import comandos_telegram as comandos


class ComandosTelegramTests(unittest.TestCase):
    def setUp(self):
        self.posiciones = [
            {
                "ticket": 11,
                "simbolo": "XAUUSD",
                "tipo": "compra",
                "profit": 12,
                "precio_apertura": 2300.0,
            },
            {
                "ticket": 12,
                "simbolo": "XAUUSD",
                "tipo": "venta",
                "profit": -3,
                "precio_apertura": 2305.0,
            },
            {
                "ticket": 13,
                "simbolo": "EURUSD",
                "tipo": "compra",
                "profit": 4,
                "precio_apertura": 1.08,
            },
        ]
        self.obtener_posiciones = Mock(return_value=self.posiciones)
        self.cerrar = Mock(return_value={"ok": True})
        self.modificar_sl = Mock(return_value={"ok": True})
        self.callback_kwargs = {
            "token": "token",
            "chat_id": "chat",
            "pendiente_por_chat": {},
            "config_bot": {},
            "obtener_posiciones_abiertas": self.obtener_posiciones,
            "cerrar_posicion": self.cerrar,
            "cerrar_posicion_parcial": Mock(),
            "modificar_sl": self.modificar_sl,
            "modificar_tp": Mock(),
            "obtener_info_cuenta": None,
            "obtener_historial_cerradas": None,
        }

    def _callback(self, data, **overrides):
        kwargs = {**self.callback_kwargs, **overrides}
        callback = {"data": data, "id": "callback", "message": {"message_id": 1}}
        comandos._manejar_boton(callback, **kwargs)

    @patch.object(comandos, "_tg")
    @patch.object(comandos.time, "sleep")
    @patch.object(
        comandos.requests,
        "get",
        side_effect=[
            SimpleNamespace(
                json=lambda: {
                    "ok": False,
                    "description": "Conflict: terminated by other getUpdates request",
                }
            ),
            KeyboardInterrupt,
        ],
    )
    def test_polling_conflict_is_reported_instead_of_silently_ignored(
        self, _get_updates, _sleep, enviar
    ):
        config = {
            "telegram_activo": True,
            "telegram_bot_token": "token",
            "telegram_chat_id": "chat",
        }

        with self.assertRaises(KeyboardInterrupt):
            comandos.escuchar_comandos_operaciones(
                config,
                Mock(),
                self.obtener_posiciones,
                self.cerrar,
                Mock(),
                self.modificar_sl,
                Mock(),
            )

        mensaje = next(
            llamada.args[2]
            for llamada in enviar.call_args_list
            if llamada.args[1] == "sendMessage"
            and "No puedo recibir comandos" in llamada.args[2].get("text", "")
        )
        self.assertIn("cierra cualquier otro proceso", mensaje["text"])
        self.cerrar.assert_not_called()

    @patch.object(comandos, "_tg")
    def test_bulk_close_requires_confirmation_and_filters_by_direction(self, mock_tg):
        self._callback("bulk:apply:close:asset:XAUUSD:compra")

        self.cerrar.assert_not_called()
        confirmation = next(
            call.args[2]
            for call in mock_tg.call_args_list
            if call.args[1] == "sendMessage"
            and call.args[2].get("reply_markup", {}).get("inline_keyboard")
        )
        self.assertIn("¿Confirmas cerrar 1 posición(es)?", confirmation["text"])

        self._callback("bulk:close_yes:XAUUSD:compra")

        self.cerrar.assert_called_once_with(11)

    @patch.object(comandos, "_tg")
    def test_bulk_break_even_only_moves_profitable_positions_for_selected_asset(self, _mock_tg):
        self._callback("bulk:apply:be:asset:XAUUSD:*")

        self.modificar_sl.assert_called_once_with(11, 2300.0)

    @patch.object(comandos, "_tg")
    def test_bulk_break_even_uses_batch_modifier_when_available(self, _mock_tg):
        modificar_sl_masivo = Mock(return_value={11: {"ok": True}})

        self._callback(
            "bulk:apply:be:asset:XAUUSD:*",
            modificar_sl_masivo=modificar_sl_masivo,
        )

        modificar_sl_masivo.assert_called_once_with([self.posiciones[0]])
        self.modificar_sl.assert_not_called()

    @patch.object(comandos, "_tg")
    def test_move_all_to_break_even_uses_batch_modifier_when_available(self, _mock_tg):
        pendientes = [dict(p) for p in (self.posiciones[0], self.posiciones[2])]
        obtener_posiciones = Mock(return_value=pendientes)
        modificar_sl_masivo = Mock(return_value={
            11: {"ok": True},
            13: {"ok": False, "error": "rechazada"},
        })

        comandos._mover_todas_a_be(
            "token",
            "chat",
            obtener_posiciones,
            self.modificar_sl,
            modificar_sl_masivo,
        )

        modificar_sl_masivo.assert_called_once_with(pendientes)
        self.modificar_sl.assert_not_called()

    @patch.object(comandos, "_tg")
    def test_move_all_to_break_even_skips_existing_or_better_stops(self, _mock_tg):
        posiciones = [
            {**self.posiciones[0], "sl": 0.0},
            {**self.posiciones[1], "profit": 1, "sl": 2300.0},
            {**self.posiciones[2], "sl": 1.09},
        ]
        obtener_posiciones = Mock(return_value=posiciones)
        modificar_sl_masivo = Mock(return_value={11: {"ok": True}})

        comandos._mover_todas_a_be(
            "token",
            "chat",
            obtener_posiciones,
            self.modificar_sl,
            modificar_sl_masivo,
        )

        modificar_sl_masivo.assert_called_once_with([posiciones[0]])

    @patch.object(comandos, "_tg")
    def test_break_even_failure_report_is_compact_and_groups_errors(self, enviar):
        posiciones = [
            {**self.posiciones[0], "profit": 1},
            {**self.posiciones[2], "profit": 1},
        ]
        obtener_posiciones = Mock(return_value=posiciones)
        modificar_sl_masivo = Mock(return_value={
            11: {"ok": False, "error": "Retcode 10016: invalid stops"},
            13: {"ok": False, "error": "Retcode 10016: invalid stops"},
        })

        comandos._mover_todas_a_be(
            "token",
            "chat",
            obtener_posiciones,
            self.modificar_sl,
            modificar_sl_masivo,
        )

        mensaje = enviar.call_args.args[2]["text"]
        self.assertIn("Fallidas: 2", mensaje)
        self.assertIn("Retcode 10016", mensaje)
        self.assertLess(len(mensaje), 4096)

    @patch.object(comandos, "_tg")
    def test_move_all_to_break_even_reports_mt5_query_errors(self, mock_tg):
        self.obtener_posiciones.side_effect = RuntimeError("(-1, 'No IPC connection')")

        comandos._mover_todas_a_be(
            "token",
            "chat",
            self.obtener_posiciones,
            self.modificar_sl,
        )

        self.modificar_sl.assert_not_called()
        self.assertIn("No pude consultar las posiciones en MT5", mock_tg.call_args.args[2]["text"])
        self.assertIn("No IPC connection", mock_tg.call_args.args[2]["text"])

    @patch.object(comandos, "_tg")
    def test_news_manual_mode_persists_blocking_without_automatic_breakeven(self, mock_tg):
        config = {"bloqueo_noticias_activo": True, "noticia_be_activo": True}
        guardar = Mock()

        self._callback(
            "news:manual",
            config_bot=config,
            guardar_config=guardar,
        )

        self.assertTrue(config["bloqueo_noticias_activo"])
        self.assertFalse(config["noticia_be_activo"])
        guardar.assert_called_once_with()
        texto_respuesta = mock_tg.call_args_list[-1].args[2]["text"]
        self.assertIn("Modo de noticias MANUAL activado", texto_respuesta)
        self.assertIn("No se cerrarán operaciones", texto_respuesta)

    @patch.object(comandos, "_tg")
    def test_news_automatic_mode_never_enables_breakeven(self, mock_tg):
        config = {"bloqueo_noticias_activo": False, "noticia_be_activo": False}

        self._callback(
            "news:auto",
            config_bot=config,
            guardar_config=Mock(),
        )

        self.assertTrue(config["bloqueo_noticias_activo"])
        self.assertFalse(config["noticia_be_activo"])
        self.assertIn("no mueven posiciones a BE", mock_tg.call_args_list[-1].args[2]["text"])

    @patch.object(comandos, "_tg")
    def test_bulk_sl_updates_only_matching_symbol_and_direction(self, _mock_tg):
        pendientes = {}
        self._callback(
            "bulk:apply:sl:asset:XAUUSD:compra",
            pendiente_por_chat=pendientes,
        )

        comandos._resolver_pendiente(
            "2290.5",
            "token",
            "chat",
            pendientes["chat"],
            pendientes,
            self.modificar_sl,
            Mock(),
            self.obtener_posiciones,
        )

        self.modificar_sl.assert_called_once_with(11, 2290.5)


if __name__ == "__main__":
    unittest.main()
