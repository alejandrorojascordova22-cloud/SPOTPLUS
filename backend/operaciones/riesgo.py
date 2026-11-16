import math
import threading

from ..conexion.conexion_mt5 import obtener_tamano_contrato, obtener_limites_volumen

# ============================================================
# GESTION DE RIESGO - SpotPlus
# ============================================================
# Regla: el % o monto a arriesgar por operacion se mantiene IGUAL en todas
# (si el SL toca, se pierde ese monto, sin importar el activo ni los pips).
# A menor distancia de SL, mayor lotaje. A mayor distancia, menor lotaje.
#
# El valor de 1 lote por cada 1.0 de precio se saca de MT5
# (trade_tick_value / trade_tick_size), que YA viene convertido a la moneda
# de la cuenta. Usar solo el tamano del contrato falla en pares JPY, oro,
# indices, cripto, etc. (por eso un SL perdia 790 y otro 98).
#
# Si el lotaje minimo del broker arriesga MAS que lo configurado, la
# operacion NO es operable (lotaje 0, operable False) en vez de pasarse.
# ============================================================


def valor_por_unidad_lote(simbolo):
    """Dinero que gana/pierde 1 lote por cada 1.0 de movimiento de precio,
    en la moneda de la cuenta. Usa los datos de MT5 del simbolo; si no estan
    disponibles cae al tamano de contrato (solo exacto si la moneda de
    cotizacion es la de la cuenta)."""
    try:
        import MetaTrader5 as mt5
        info = mt5.symbol_info(simbolo)
        if info is None:
            mt5.symbol_select(simbolo, True)
            info = mt5.symbol_info(simbolo)
        if info is not None:
            tick_valor = getattr(info, "trade_tick_value_loss", 0) or info.trade_tick_value
            tick_tamano = info.trade_tick_size
            if tick_valor and tick_valor > 0 and tick_tamano and tick_tamano > 0:
                return tick_valor / tick_tamano
    except Exception as e:
        print(f"[riesgo] no se pudo leer tick_value de {simbolo}: {e}")
    return obtener_tamano_contrato(simbolo)


def dimensionar_lote(dinero_riesgo, distancia_sl, valor_unidad, paso, minimo, maximo,
                     permitir_minimo=False):
    """Motor PURO de dimensionado (no toca MT5): lo usan el bot en vivo
    (calcular_lotaje) y el backtest, para que ambos arriesguen igual.

    valor_unidad: dinero que mueve 1 lote por cada 1.0 de precio, en la moneda
    de la cuenta (trade_tick_value / trade_tick_size).
    Devuelve dict {lotaje, lotaje_crudo, riesgo_real, operable, advertencia}.
    Si el lote minimo del broker arriesga mas que dinero_riesgo y
    permitir_minimo es False -> operable False y lotaje 0 (no se opera)."""
    valor_por_lote = distancia_sl * valor_unidad   # perdida de 1 lote si toca el SL
    if dinero_riesgo <= 0 or valor_por_lote <= 0:
        return None
    lotaje_crudo = dinero_riesgo / valor_por_lote
    lotaje = _ajustar_a_paso(lotaje_crudo, paso)

    advertencia = None
    operable = True
    if lotaje < minimo:
        riesgo_con_minimo = minimo * valor_por_lote
        if permitir_minimo:
            advertencia = (
                f"El riesgo definido ({dinero_riesgo:,.2f}) da un lotaje ({lotaje_crudo:.4f}) "
                f"menor al minimo permitido ({minimo}). Se usa el minimo del broker: "
                f"arriesga {riesgo_con_minimo:,.2f}, MAS de lo configurado."
            )
            lotaje = minimo
        else:
            advertencia = (
                f"Operacion omitida: con el lote minimo del broker ({minimo}) y este SL "
                f"se arriesgarian {riesgo_con_minimo:,.2f}, mas que los {dinero_riesgo:,.2f} "
                f"configurados (lotaje calculado {lotaje_crudo:.4f})."
            )
            lotaje = 0.0
            operable = False
    elif lotaje > maximo:
        advertencia = (
            f"El riesgo definido da un lotaje ({lotaje_crudo:.4f}) mayor al maximo "
            f"permitido ({maximo}). Se usa el maximo del broker, lo cual "
            f"arriesga MENOS dinero del configurado."
        )
        lotaje = maximo

    return {
        "lotaje": lotaje,
        "lotaje_crudo": lotaje_crudo,
        "riesgo_real": round(lotaje * valor_por_lote, 2),
        "operable": operable,
        "advertencia": advertencia,
    }


def riesgo_configurado(config, n_simbolos=1, valor_senal=None):
    """Que riesgo aplicar a una operacion segun la config del bot. Devuelve
    (modo, valor) con modo "porcentaje" o "fijo", o None si la config usa
    lote fijo (volumen_operacion). Misma prioridad que el bot en vivo:
      1) tope de riesgo total (riesgo_total_activo) manda sobre todo,
      2) riesgo propio de la operacion/estrategia (valor_senal),
      3) modo_riesgo del bot ("porcentaje" o "monto_fijo")."""
    modo_cfg = config.get("modo_riesgo")
    pct_total = riesgo_total_por_operacion(config, n_simbolos)
    if pct_total is not None:
        return "porcentaje", pct_total
    if valor_senal is not None:
        return ("porcentaje" if modo_cfg == "porcentaje" else "fijo"), valor_senal
    if modo_cfg in ("porcentaje", "monto_fijo"):
        valor = config.get("riesgo_valor")
        if valor:
            return ("porcentaje" if modo_cfg == "porcentaje" else "fijo"), float(valor)
    return None


def calcular_lotaje(balance, precio_entrada, sl, simbolo, modo="porcentaje", valor=1.0,
                    permitir_minimo=False):
    """
    Calcula el lotaje a operar segun el riesgo configurado.

    modo: "porcentaje" (valor = % del balance) o "fijo" (valor = monto fijo
    en la moneda de la cuenta).

    permitir_minimo: False (por defecto) -> si el lote minimo del broker
    arriesga mas que lo configurado, NO se opera (lotaje 0, operable False).
    True -> comportamiento viejo: se usa el minimo aunque arriesgue de mas.

    Devuelve dict {"lotaje", "dinero_riesgo", "riesgo_real", "distancia_sl",
    "operable", "advertencia"} o None si faltan datos esenciales (sin SL no
    hay riesgo real que calcular).
    """
    if balance is None or balance <= 0:
        return None
    if precio_entrada is None or sl is None or sl == 0:
        return None

    distancia_sl = abs(precio_entrada - sl)
    if distancia_sl <= 0:
        return None

    if modo == "porcentaje":
        dinero_riesgo = balance * (valor / 100)
    elif modo == "fijo":
        dinero_riesgo = valor
    else:
        return None

    limites = obtener_limites_volumen(simbolo)
    r = dimensionar_lote(
        dinero_riesgo, distancia_sl, valor_por_unidad_lote(simbolo),
        limites["paso"], limites["minimo"], limites["maximo"], permitir_minimo,
    )
    if r is None:
        return None
    return {
        "lotaje": r["lotaje"],
        "dinero_riesgo": dinero_riesgo,
        "riesgo_real": r["riesgo_real"],
        "distancia_sl": distancia_sl,
        "operable": r["operable"],
        "advertencia": r["advertencia"],
    }


def _ajustar_a_paso(lotaje, paso):
    """Redondea el lotaje hacia ABAJO al multiplo de 'paso' mas cercano.
    Redondear hacia abajo nunca arriesga mas de lo configurado."""
    if paso <= 0:
        return round(lotaje, 2)
    pasos = math.floor(round(lotaje / paso, 9))   # round evita 0.29999 -> 0.28
    resultado = pasos * paso
    decimales = len(f"{paso:.10f}".rstrip("0").split(".")[-1])
    return round(resultado, decimales)


# ============================================================
# Avisos de Break Even agrupados para Telegram
# Con varias operaciones abiertas se manda UN mensaje por ciclo; el detalle
# por ticket solo sale si el usuario manda /be_detalle.
# ============================================================
_lock = threading.Lock()
_ultimo_detalle = {"titulo": "", "simbolo": "", "movidos": []}


def armar_aviso_be(titulo, simbolo, movidos):
    """movidos: lista de (ticket, motivo). Devuelve el texto a enviar, o None
    si no hubo ninguno. Con 1 operación el mensaje es el de siempre; con más,
    un resumen corto (el detalle queda guardado para /be_detalle)."""
    if not movidos:
        return None
    with _lock:
        _ultimo_detalle.update({"titulo": titulo, "simbolo": simbolo, "movidos": list(movidos)})
    if len(movidos) == 1:
        ticket, motivo = movidos[0]
        return (
            f"🔒 <b>{titulo}</b>\n"
            f"{simbolo} · Ticket {ticket} movido a BE\n"
            f"Motivo: {motivo}"
        )
    motivos = {}
    for _, motivo in movidos:
        motivos[motivo] = motivos.get(motivo, 0) + 1
    resumen_motivos = ", ".join(f"{m} ({n})" for m, n in motivos.items())
    return (
        f"🔒 <b>{titulo}</b>\n"
        f"{simbolo} · {len(movidos)} operaciones movidas a BE\n"
        f"Motivo: {resumen_motivos}\n"
        f"Para ver los tickets: /be_detalle"
    )


def riesgo_total_por_operacion(config, n_simbolos):
    """Riesgo (% del balance) que le toca a CADA operación para que, con todas
    las posiciones posibles abiertas, la suma NO pase del riesgo total (ej. 1%).

    Reparte riesgo_total_pct entre los activos que se analizan (n_simbolos) y,
    dentro de cada activo, entre sus operaciones máximas abiertas
    (max_operaciones_por_simbolo; si es 0/ilimitado se asume 2 = una pareja
    runner + corta). Devuelve None si el riesgo total está desactivado."""
    if not config.get("riesgo_total_activo"):
        return None
    total = float(config.get("riesgo_total_pct") or 1.0)
    n = max(1, int(n_simbolos or 1))
    ops = int(config.get("max_operaciones_por_simbolo") or 0) or 2
    return total / (n * ops)


_pendientes_be = {}  # (titulo, simbolo) -> lista de (ticket, motivo)


def encolar_aviso_be(titulo, simbolo, movidos, enviar, ventana=8):
    """Junta los BE que lleguen dentro de `ventana` segundos (aunque sean de
    ciclos distintos del bot) y manda UN solo mensaje con `enviar(texto)`."""
    if not movidos:
        return
    clave = (titulo, simbolo)
    with _lock:
        primero = clave not in _pendientes_be
        _pendientes_be.setdefault(clave, []).extend(movidos)
    if not primero:
        return

    def _vaciar():
        with _lock:
            lote = _pendientes_be.pop(clave, [])
        texto = armar_aviso_be(titulo, simbolo, lote)
        if texto:
            try:
                enviar(texto)
            except Exception as e:
                print(f"[aviso BE] error al enviar: {e}")

    t = threading.Timer(ventana, _vaciar)
    t.daemon = True
    t.start()


def texto_detalle_be():
    with _lock:
        d = dict(_ultimo_detalle)
    if not d["movidos"]:
        return "Todavía no hay avisos de BE para detallar."
    lineas = [f"🔒 <b>{d['titulo']}</b> · {d['simbolo']} (último aviso)"]
    lineas += [f"• Ticket {t} — {m}" for t, m in d["movidos"]]
    return "\n".join(lineas)

# ============================================================
# Estimaciones de ganancia / pérdida (calculadora + bitácora + Telegram)
# ============================================================
def estimar_operacion(simbolo, volumen, entrada, sl, tp):
    """Dinero que se pierde si toca el SL y se gana si toca el TP, con el
    lotaje indicado. Devuelve None si faltan datos. SL/TP en 0 se ignoran."""
    try:
        volumen, entrada = float(volumen or 0), float(entrada or 0)
        sl, tp = float(sl or 0), float(tp or 0)
    except (TypeError, ValueError):
        return None
    if volumen <= 0 or entrada <= 0:
        return None
    contrato = valor_por_unidad_lote(simbolo)
    perdida = abs(entrada - sl) * contrato * volumen if sl else None
    ganancia = abs(tp - entrada) * contrato * volumen if tp else None
    rr = round(ganancia / perdida, 2) if perdida and ganancia else None
    return {
        "perdida": round(perdida, 2) if perdida is not None else None,
        "ganancia": round(ganancia, 2) if ganancia is not None else None,
        "ratio_rr": rr,
    }


def linea_estimacion(simbolo, volumen, entrada, sl, tp):
    """Texto de una línea para avisos y bitácora. Vacío si no hay datos."""
    e = estimar_operacion(simbolo, volumen, entrada, sl, tp)
    if not e:
        return ""
    partes = []
    if e["perdida"] is not None:
        partes.append(f"Pérdida estimada si SL: -{e['perdida']:,.2f}")
    if e["ganancia"] is not None:
        partes.append(f"Ganancia estimada si TP: +{e['ganancia']:,.2f}")
    if e["ratio_rr"] is not None:
        partes.append(f"R:R 1:{e['ratio_rr']}")
    return " · ".join(partes)


def calculo_completo(balance, entrada, sl, tp, simbolo, modo="porcentaje", valor=1.0,
                     parcial_pct=None, parcial_distancia=None):
    """Calculadora completa: lotaje sugerido + pérdida/ganancia estimadas.
    Usa EXACTAMENTE el mismo motor (calcular_lotaje) que el bot al operar.
    parcial_pct (% del lote a cerrar) y parcial_distancia (puntos de precio a
    favor donde se cierra) son opcionales."""
    base = calcular_lotaje(balance, entrada, sl, simbolo, modo, valor)
    if base is None:
        return None
    if not base.get("operable", True):
        resultado = dict(base)
        resultado["perdida_estimada"] = 0.0
        resultado["riesgo_real_pct"] = 0.0
        return resultado
    lote = base["lotaje"]
    est = estimar_operacion(simbolo, lote, entrada, sl, tp) or {}
    perdida = est.get("perdida") if est.get("perdida") is not None else base["dinero_riesgo"]
    resultado = dict(base)
    resultado["perdida_estimada"] = perdida
    resultado["riesgo_real_pct"] = round(perdida / balance * 100, 2) if balance else None
    if est.get("ganancia") is not None:
        resultado["ganancia_estimada"] = est["ganancia"]
        resultado["ratio_rr"] = est.get("ratio_rr") or 0
    if perdida and balance:
        resultado["oportunidades"] = int(balance // perdida)
    if parcial_pct and parcial_distancia and 0 < parcial_pct < 100:
        contrato = valor_por_unidad_lote(simbolo)
        limites = obtener_limites_volumen(simbolo)
        lote_parcial = _ajustar_a_paso(lote * parcial_pct / 100, limites["paso"])
        lote_restante = round(lote - lote_parcial, 8)
        if lote_parcial > 0 and lote_restante > 0:
            ganancia_parcial = parcial_distancia * contrato * lote_parcial
            perdida_restante = abs(entrada - sl) * contrato * lote_restante
            resultado["parcial"] = {
                "lote_parcial": round(lote_parcial, 4),
                "ganancia_parcial": round(ganancia_parcial, 2),
                "lote_restante": round(lote_restante, 4),
                "perdida_restante": round(perdida_restante, 2),
                "ganancia_restante_si_tp": round(
                    abs(tp - entrada) * contrato * lote_restante, 2) if tp else 0.0,
            }
    return resultado