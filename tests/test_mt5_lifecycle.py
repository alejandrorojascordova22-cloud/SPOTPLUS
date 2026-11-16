import os
import socket
import signal
import unittest
from unittest.mock import patch

from backend.conexion import conexion_mt5
from backend import multicuenta
from backend.conexion import conexion_mt5 as conexion_mt5_multicuenta
from backend.procesos.proceso_servidor import comprobar_puerto_disponible


class Mt5LifecycleTests(unittest.TestCase):
    def test_disconnect_does_not_shutdown_a_connection_not_initialized_here(self):
        connectors = (conexion_mt5, conexion_mt5_multicuenta)

        for connector in connectors:
            with self.subTest(module=connector.__name__):
                with (
                    patch.object(connector, "_mt5_initialized", False),
                    patch.object(connector.mt5, "shutdown") as shutdown,
                    patch.object(connector, "close_owned_terminal_processes"),
                ):
                    connector.desconectar()

                shutdown.assert_not_called()

    def test_port_check_fails_before_backend_startup_when_port_is_occupied(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]

            with patch(
                "backend.procesos.proceso_servidor._procesos_escuchando_en_puerto",
                return_value={os.getpid() + 1},
            ):
                with self.assertRaisesRegex(
                    RuntimeError, f"puerto {port} ya está ocupado"
                ):
                    comprobar_puerto_disponible(port)

    def test_port_check_allows_the_socket_already_bound_by_this_server(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]

            with (
                patch(
                    "backend.procesos.proceso_servidor._procesos_escuchando_en_puerto",
                    return_value={os.getpid()},
                ),
            ):
                comprobar_puerto_disponible(port)

    def test_lost_connection_does_not_initialize_mt5_again(self):
        connectors = (conexion_mt5, conexion_mt5_multicuenta)

        for connector in connectors:
            with self.subTest(module=connector.__name__):
                with (
                    patch.object(connector.mt5, "terminal_info", return_value=None),
                    patch.object(connector.mt5, "account_info", return_value=None),
                    patch.object(connector.mt5, "last_error", return_value=(-10004, "closed")),
                    patch.object(connector, "conectar") as conectar,
                ):
                    self.assertFalse(connector.verificar_conexion())

                conectar.assert_not_called()

    def test_closing_backend_closes_only_terminal_started_by_it(self):
        procesos_antes = {101}
        procesos_despues = {101, 202}
        eventos = []

        with (
            patch.object(
                conexion_mt5,
                "terminal_process_ids",
                side_effect=[procesos_antes, procesos_despues],
            ),
            patch.object(conexion_mt5.mt5, "initialize", return_value=True),
            patch.object(conexion_mt5.mt5, "login", return_value=True),
            patch.object(
                conexion_mt5.mt5,
                "shutdown",
                side_effect=lambda: eventos.append("shutdown"),
            ),
            patch.object(
                conexion_mt5,
                "close_owned_terminal_processes",
                side_effect=lambda path, pids: eventos.append((path, pids)),
            ),
        ):
            self.assertTrue(conexion_mt5.conectar())
            conexion_mt5.desconectar()

        self.assertEqual(eventos[0], "shutdown")
        self.assertEqual(eventos[1], (conexion_mt5.TERMINAL_PATH, {202}))

    def test_multicuenta_requests_a_graceful_child_shutdown(self):
        class FakeProcess:
            def __init__(self):
                self.signals = []
                self.wait_timeouts = []

            def poll(self):
                return None

            def send_signal(self, received_signal):
                self.signals.append(received_signal)

            def wait(self, timeout):
                self.wait_timeouts.append(timeout)

        process = FakeProcess()
        expected_signal = (
            signal.CTRL_BREAK_EVENT
            if multicuenta.os.name == "nt"
            else signal.SIGINT
        )

        multicuenta._detener_proceso(process)

        self.assertEqual(process.signals, [expected_signal])
        self.assertEqual(process.wait_timeouts, [10])


if __name__ == "__main__":
    unittest.main()
