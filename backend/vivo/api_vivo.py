"""WebSocket /ws/vivo: precio en vivo para el gráfico.

Protocolo (JSON):
  cliente -> {"type":"auth","key":"<API_KEY>"}          (PRIMER mensaje)
  cliente -> {"type":"suscribir","simbolo":"XAUUSD"}
  cliente -> {"type":"desuscribir","simbolo":"XAUUSD"}
  servidor-> {"type":"tick","simbolo":..,"bid":..,"ask":..,"t":<epoch s>}

La autenticación va aquí porque el middleware de API key del servidor solo
cubre HTTP (/api/*), no WebSockets. La clave va en el primer mensaje y no en
la URL para que no quede en historiales ni logs.

Alternativa para el modo desarrollo local: el proxy de Vite (que ya conoce la
API_KEY y no la expone al navegador) agrega la cabecera ``X-API-Key`` al
abrir el WebSocket. Si esa cabecera es válida no hace falta el mensaje
``auth`` (si el navegador lo manda igual, se ignora).
"""
import asyncio
import hmac
import re

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

_SIMBOLO_OK = re.compile(r"^[A-Za-z0-9._#\-]{1,20}$")
MAX_SIMBOLOS_POR_CLIENTE = 5
TIMEOUT_AUTH_SEG = 5


def _clave_valida(clave, api_key):
    return bool(
        api_key
        and isinstance(clave, str)
        and hmac.compare_digest(clave.encode(), api_key.encode())
    )


def crear_router(hub, api_key, obtener_velas=None, obtener_analisis=None, obtener_lentes=None):
    """``obtener_velas(simbolo, timeframe, cantidad) -> [velas] | None`` (opcional)
    habilita GET /api/vivo/velas, que protege el middleware de API key.
    ``obtener_analisis(simbolo) -> dict`` (opcional) habilita GET /api/vivo/analisis:
    zonas, niveles y motivos del bot para dibujarlos en el gráfico (solo lectura)."""
    router = APIRouter()

    if obtener_velas is not None:
        @router.get("/api/vivo/velas")
        def velas_vivo(simbolo: str, timeframe: str = "M1", cantidad: int = 500):
            if not _SIMBOLO_OK.match(simbolo):
                raise HTTPException(status_code=400, detail="Símbolo no válido")
            velas = obtener_velas(simbolo, timeframe.strip().upper(), cantidad)
            if not velas:
                return {"error": f"MT5 no devolvió velas de {simbolo} en {timeframe}."}
            return {"timeframe": timeframe.strip().upper(), "velas": velas}

    if obtener_analisis is not None:
        @router.get("/api/vivo/analisis")
        def analisis_vivo(simbolo: str):
            if not _SIMBOLO_OK.match(simbolo):
                raise HTTPException(status_code=400, detail="Símbolo no válido")
            return obtener_analisis(simbolo)

    if obtener_lentes is not None:
        @router.get("/api/vivo/lentes")
        def lentes_vivo(simbolo: str):
            if not _SIMBOLO_OK.match(simbolo):
                raise HTTPException(status_code=400, detail="Símbolo no válido")
            return obtener_lentes(simbolo)

    @router.websocket("/ws/vivo")
    async def ws_vivo(ws: WebSocket):
        await ws.accept()
        # Cabecera puesta por el proxy de Vite (modo local): ya viene autenticado.
        if not _clave_valida(ws.headers.get("x-api-key"), api_key):
            try:
                msg = await asyncio.wait_for(ws.receive_json(), TIMEOUT_AUTH_SEG)
            except Exception:
                await ws.close(code=1008)
                return
            clave = msg.get("key") if isinstance(msg, dict) else None
            if msg.get("type") != "auth" or not _clave_valida(clave, api_key):
                await ws.close(code=1008)
                return

        cola = hub.nueva_cola()
        suscritos = set()

        async def enviar():
            while True:
                await ws.send_json(await cola.get())

        envio = asyncio.create_task(enviar())
        try:
            while True:
                msg = await ws.receive_json()
                if not isinstance(msg, dict):
                    continue
                simbolo = msg.get("simbolo")
                if msg.get("type") == "desuscribir":
                    if isinstance(simbolo, str) and simbolo in suscritos:
                        suscritos.discard(simbolo)
                        hub.desuscribir(cola, simbolo)
                    continue
                if msg.get("type") != "suscribir":
                    continue
                if (
                    isinstance(simbolo, str)
                    and _SIMBOLO_OK.match(simbolo)
                    and (simbolo in suscritos or len(suscritos) < MAX_SIMBOLOS_POR_CLIENTE)
                ):
                    suscritos.add(simbolo)
                    hub.suscribir(cola, simbolo)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            envio.cancel()
            hub.quitar(cola)

    return router