import time
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.vivo.api_vivo import crear_router
from backend.vivo.hub import HubTicks

CLAVE = "clave-de-prueba"


def _app(hub):
    app = FastAPI()
    app.include_router(crear_router(hub, CLAVE))
    return app


class TestVivo(unittest.TestCase):
    def test_sin_clave_se_rechaza(self):
        cliente = TestClient(_app(HubTicks()))
        with cliente.websocket_connect("/ws/vivo") as ws:
            ws.send_json({"type": "auth", "key": "otra"})
            with self.assertRaises(WebSocketDisconnect):
                ws.receive_json()

    def test_cabecera_del_proxy_autentica_sin_clave_en_el_mensaje(self):
        hub = HubTicks()
        cliente = TestClient(_app(hub))
        with cliente.websocket_connect("/ws/vivo", headers={"X-API-Key": CLAVE}) as ws:
            # el navegador (modo local) manda auth con clave vacía: se ignora
            ws.send_json({"type": "auth", "key": ""})
            ws.send_json({"type": "suscribir", "simbolo": "XAUUSD"})
            time.sleep(0.2)
            hub.publicar("XAUUSD", 3873.21, 3873.4)
            self.assertEqual(ws.receive_json()["bid"], 3873.21)

    def test_cabecera_incorrecta_no_autentica(self):
        cliente = TestClient(_app(HubTicks()))
        with cliente.websocket_connect("/ws/vivo", headers={"X-API-Key": "mala"}) as ws:
            ws.send_json({"type": "auth", "key": "tampoco"})
            with self.assertRaises(WebSocketDisconnect):
                ws.receive_json()

    def test_recibe_ticks_publicados_por_cualquier_fuente(self):
        hub = HubTicks()
        cliente = TestClient(_app(hub))
        with cliente.websocket_connect("/ws/vivo") as ws:
            ws.send_json({"type": "auth", "key": CLAVE})
            ws.send_json({"type": "suscribir", "simbolo": "XAUUSD"})
            time.sleep(0.2)
            hub.publicar("XAUUSD", 3879.95, 3880.05)
            tick = ws.receive_json()
            self.assertEqual(tick["bid"], 3879.95)
            self.assertEqual(tick["simbolo"], "XAUUSD")

    def test_sondeo_estilo_mt5_y_sin_repetidos(self):
        precios = iter([(1.0, 1.1), (1.0, 1.1), (2.0, 2.1)] + [(2.0, 2.1)] * 200)
        hub = HubTicks(lambda s: dict(zip(("bid", "ask"), next(precios))), intervalo=0.02)
        cliente = TestClient(_app(hub))
        with cliente.websocket_connect("/ws/vivo") as ws:
            ws.send_json({"type": "auth", "key": CLAVE})
            ws.send_json({"type": "suscribir", "simbolo": "EURUSD"})
            vistos = [ws.receive_json()["bid"], ws.receive_json()["bid"]]
        self.assertEqual(vistos, [1.0, 2.0])  # el repetido no se reenvía
        time.sleep(0.1)
        self.assertEqual(hub._hilos, {})  # sin clientes se apaga el sondeo

    def test_simbolo_invalido_se_ignora(self):
        hub = HubTicks(lambda s: {"bid": 1, "ask": 2}, intervalo=0.02)
        cliente = TestClient(_app(hub))
        with cliente.websocket_connect("/ws/vivo") as ws:
            ws.send_json({"type": "auth", "key": CLAVE})
            ws.send_json({"type": "suscribir", "simbolo": "../../etc"})
            time.sleep(0.1)
        self.assertEqual(hub._hilos, {})

    def test_el_tick_conserva_la_hora_de_la_fuente(self):
        hub = HubTicks(lambda s: {"bid": 1.0, "ask": 1.1, "t": 1760000000.5}, intervalo=0.02)
        cliente = TestClient(_app(hub))
        with cliente.websocket_connect("/ws/vivo") as ws:
            ws.send_json({"type": "auth", "key": CLAVE})
            ws.send_json({"type": "suscribir", "simbolo": "XAUUSD"})
            self.assertEqual(ws.receive_json()["t"], 1760000000.5)

    def test_velas_http(self):
        llamadas = []

        def fuente(simbolo, tf, cantidad):
            llamadas.append((simbolo, tf, cantidad))
            return [{"time": 1, "open": 1, "high": 2, "low": 0.5, "close": 1.5}] if simbolo == "XAUUSD" else None

        app = FastAPI()
        app.include_router(crear_router(HubTicks(), CLAVE, fuente))
        c = TestClient(app)
        r = c.get("/api/vivo/velas", params={"simbolo": "XAUUSD", "timeframe": "m1", "cantidad": 50})
        self.assertEqual(r.json()["timeframe"], "M1")
        self.assertEqual(llamadas, [("XAUUSD", "M1", 50)])
        self.assertIn("error", c.get("/api/vivo/velas", params={"simbolo": "NADA"}).json())
        self.assertEqual(c.get("/api/vivo/velas", params={"simbolo": "../x"}).status_code, 400)

    def test_desuscribir_libera_el_cupo_y_apaga_el_sondeo(self):
        hub = HubTicks(lambda s: {"bid": 1, "ask": 2}, intervalo=0.02)
        cliente = TestClient(_app(hub))
        with cliente.websocket_connect("/ws/vivo") as ws:
            ws.send_json({"type": "auth", "key": CLAVE})
            for i in range(8):  # más que el máximo por conexión, pero siempre soltando
                ws.send_json({"type": "suscribir", "simbolo": f"S{i}"})
                ws.receive_json()
                ws.send_json({"type": "desuscribir", "simbolo": f"S{i}"})
            time.sleep(0.2)
            self.assertEqual(hub._hilos, {})


if __name__ == "__main__":
    unittest.main()
