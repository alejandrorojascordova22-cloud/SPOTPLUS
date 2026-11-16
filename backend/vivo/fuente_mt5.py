"""Fuente MT5 para el gráfico en vivo.

Vive aparte de conexion_mt5.py para no tocar el código que opera. Usa el mismo
candado de MT5, así que no choca con órdenes ni con el escáner.

Importante: el tick lleva la hora que MT5 le pone (``tick.time``), que está en
la MISMA base de tiempo que las velas de MT5 (hora del servidor del bróker
tratada como UTC). Si se usara ``time.time()`` la vela viva caería en el
casillero equivocado cuando el bróker no está en UTC+0.
"""
import pandas as pd

from ..conexion.conexion_mt5 import TIMEFRAMES, _con_candado, _copiar_velas, mt5
from ..operaciones.tiempo import timestamps_epoch_segundos

MAX_VELAS = 5000

_resueltos = {}


def _resolver_simbolo(simbolo):
    """Nombre exacto del símbolo en el bróker.

    MT5 distingue mayúsculas ("eurusd" no existe, "EURUSD" sí) y algunos brókers
    añaden sufijo (EURUSDm, EURUSD.a ...). Se prueba tal cual, luego sin distinguir
    mayúsculas y por último el más corto que empiece igual. Solo se recuerdan los
    aciertos, para que un símbolo que aparezca después en Market Watch se encuentre.
    Debe llamarse con el candado de MT5 tomado (lo hacen las funciones de abajo).
    """
    if simbolo in _resueltos:
        return _resueltos[simbolo]
    try:
        if mt5.symbol_info(simbolo) is not None:
            _resueltos[simbolo] = simbolo
            return simbolo
        nombres = [s.name for s in (mt5.symbols_get() or [])]
        buscado = simbolo.upper()
        exactos = [n for n in nombres if n.upper() == buscado]
        parecidos = sorted((n for n in nombres if n.upper().startswith(buscado)), key=len)
        elegido = (exactos or parecidos or [None])[0]
        if elegido:
            _resueltos[simbolo] = elegido
            return elegido
    except Exception:
        pass
    return simbolo


@_con_candado
def obtener_tick_vivo(simbolo):
    """{"bid","ask","t"} con t en la base de tiempo de las velas, o None."""
    tick = mt5.symbol_info_tick(_resolver_simbolo(simbolo))
    if tick is None:
        return None
    msc = getattr(tick, "time_msc", 0) or 0
    t = msc / 1000.0 if msc else float(tick.time)
    return {"bid": float(tick.bid), "ask": float(tick.ask), "t": t}


@_con_candado
def obtener_velas_recientes(simbolo, timeframe, cantidad=500):
    """Últimas ``cantidad`` velas (incluye la vela en formación). None si falla."""
    tf = TIMEFRAMES.get(str(timeframe).upper())
    if tf is None:
        return None
    cantidad = max(10, min(int(cantidad), MAX_VELAS))
    velas = _copiar_velas(_resolver_simbolo(simbolo), tf, cantidad)
    if velas is None:
        return None
    df = pd.DataFrame(velas)
    df["time"] = pd.to_datetime(df["time"], unit="s")
    df = df.sort_values("time").drop_duplicates(subset="time")
    tiempos = timestamps_epoch_segundos(df["time"])
    return [
        {"time": int(t), "open": round(float(o), 5), "high": round(float(h), 5),
         "low": round(float(l), 5), "close": round(float(c), 5)}
        for t, o, h, l, c in zip(tiempos, df["open"], df["high"], df["low"], df["close"])
    ]