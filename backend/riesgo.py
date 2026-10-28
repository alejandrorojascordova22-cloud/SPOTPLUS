import threading

from .conexion_mt5 import obtener_tamano_contrato

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
# Estimaciones de ganancia / pérdida (bitácora + Telegram)
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
    contrato = obtener_tamano_contrato(simbolo)
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