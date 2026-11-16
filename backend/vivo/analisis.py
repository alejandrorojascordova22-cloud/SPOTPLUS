"""Lo que el bot "piensa", para dibujarlo en el gráfico en vivo.

Solo LEE el latido que ya escribe el escáner (escaner_estado.json): no toca MT5,
no recalcula la estrategia y no puede cambiar ninguna decisión del bot. Por eso
se puede consultar cada pocos segundos sin cargar nada.
"""
from datetime import datetime


def _leer_latido():
    from ..analista.api_config import _leer_latido as leer
    return leer() or {}


def obtener_analisis(simbolo):
    """{"corriendo", "ultima", "hace_min", "escenarios": [...]} del símbolo pedido.

    El gráfico puede usar XAUUSD o XAUUSDm: se compara contra el nombre base y
    contra el nombre de MT5 que guardó el escáner.
    """
    lat = _leer_latido()
    intervalo = int(lat.get("intervalo_min", 5) or 5)
    salida = {"corriendo": False, "ultima": lat.get("ts"), "hace_min": None, "escenarios": []}
    try:
        edad = (datetime.now() - datetime.fromisoformat(lat["ts"])).total_seconds()
        salida["hace_min"] = round(edad / 60, 1)
        salida["corriendo"] = edad <= (intervalo + 2) * 60
    except (KeyError, ValueError, TypeError):
        return salida

    buscado = str(simbolo).strip().upper()
    mejor = None
    for base, p in (lat.get("proyecciones") or {}).items():
        b = str(base).upper()
        mt5 = str(p.get("mt5") or "").upper()
        if buscado in (b, mt5) or (buscado.startswith(b) and (mejor is None or len(b) > len(mejor[0]))):
            mejor = (b, p)
            if buscado in (b, mt5):
                break
    if mejor:
        salida["escenarios"] = list(mejor[1].get("escenarios") or [])
    return salida
