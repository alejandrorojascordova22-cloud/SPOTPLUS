"""
CONTROL DE OPERACIONES POR TELEGRAM (MENÚ COMPACTO) - SpotPlus
=================================================================
Escuchador de long-polling que corre DENTRO del mismo proceso de
backend/servidor.py (no por HTTP, llamada directa a las funciones de MT5).

Teclado fijo (siempre visible, debajo del cuadro de texto):
    [📊 Ver posiciones]     [🛡 Mover TODAS a BE]
    [📒 Bitácora]           [⏸ Pausar/Reanudar bot]
    [💰 Balance]            [🎚 Riesgo]
    [📤 Exportar historial] [🏦 Cuentas]
    [📰 Noticias]           [🧰 Acciones posiciones]

"📊 Ver posiciones" manda UN SOLO mensaje con la lista de operaciones
abiertas como botones (uno por ticket). Al tocar un ticket, ESE MISMO
mensaje se edita (no manda uno nuevo) para mostrar los botones de acción
de esa operación: Cerrar, Cerrar 50%, Mover a BE, Quitar SL, Mover SL,
Mover TP y "⬅ Volver a la lista". Quitar SL requiere confirmación y evita
que el BE automático vuelva a poner el stop en esa operación.

"🛡 Mover TODAS a BE" mueve a breakeven (SL = precio de apertura) TODAS
las operaciones abiertas que estén en ganancia, de una sola vez.

"📰 Noticias" permite elegir entre protección automática por noticias
(bloquear entradas nuevas y mover a BE las operaciones ganadoras) o modo
manual (bloquear entradas nuevas y dejar la gestión al usuario). Nunca se
cierran posiciones por noticia.

"🧰 Acciones posiciones" permite cerrar operaciones con confirmación,
mover a BE las ganadoras por activo/dirección o cambiar el SL por activo.

"📒 Bitácora" muestra las últimas notas guardadas o permite borrar TODO
el historial (con confirmación para evitar borrados accidentales).

"⏸ Pausar/Reanudar bot" activa/desactiva el ciclo automático de trading
(config_bot["activo"]) sin tocar el servidor ni la app.

"💰 Balance" muestra balance, equity, margen libre y si la cuenta es
real o demo, en vivo.

"🎚 Riesgo" deja elegir, con botones, el % del balance a arriesgar por
operación (modo porcentaje) entre valores predefinidos.

"📤 Exportar historial" genera un CSV con las operaciones cerradas de
los últimos N días (todas las cuentas/símbolos) y lo manda como archivo
por Telegram.

"🏦 Cuentas" (solo si usas multicuenta, backend/datos/cuentas.json) lista las
cuentas registradas y permite activar/pausar el trading automático de
cada una directamente desde el chat, sin escribir comandos.
"""
import csv
import io
import math
import threading
import time
from collections import defaultdict

import requests


def _tg(token, metodo, payload):
    try:
        r = requests.post(f"https://api.telegram.org/bot{token}/{metodo}", json=payload, timeout=10)
        respuesta = r.json()
        if not respuesta.get("ok"):
            print(
                f"Telegram rechazó {metodo}: "
                f"{respuesta.get('description', 'error sin detalle')}"
            )
        return respuesta
    except requests.RequestException as exc:
        print(f"No se pudo llamar a Telegram ({metodo}): {exc}")
        return {"ok": False}


def _tg_documento(token, chat_id, nombre_archivo, contenido_texto, caption=""):
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendDocument",
            data={"chat_id": chat_id, "caption": caption},
            files={"document": (nombre_archivo, contenido_texto.encode("utf-8"), "text/csv")},
            timeout=30,
        )
        return r.json()
    except requests.RequestException:
        return {"ok": False}


def _teclado_principal():
    """Teclado fijo debajo del cuadro de texto, siempre visible."""
    return {
        "keyboard": [
            [{"text": "📊 Ver posiciones"}, {"text": "🛡 Mover TODAS a BE"}],
            [{"text": "📒 Bitácora"}, {"text": "⏸ Pausar/Reanudar bot"}],
            [{"text": "💰 Balance"}, {"text": "🎚 Riesgo"}],
            [{"text": "📤 Exportar historial"}, {"text": "🏦 Cuentas"}],
            [{"text": "📈 Estadísticas"}, {"text": "🧮 Calculadora"}],
            [{"text": "📰 Noticias"}, {"text": "🧰 Acciones posiciones"}],
            [{"text": "🎯 Proyecciones"}],
        ],
        "resize_keyboard": True,
        "is_persistent": True,
    }


def _texto_y_botones_lista(posiciones):
    if not posiciones:
        return "No hay operaciones abiertas.", None
    lineas = ["<b>Operaciones abiertas — toca una para operarla</b>", ""]
    filas = []
    for p in posiciones:
        lineas.append(
            f"• {p['simbolo']} {p['tipo'].upper()} {p['volumen']} lotes · P/L: {round(p['profit'], 2)}"
        )
        filas.append([{
            "text": f"{p['simbolo']} {p['tipo'].upper()} {p['volumen']} · {round(p['profit'], 2)}",
            "callback_data": f"ver:{p['ticket']}",
        }])
    return "\n".join(lineas), {"inline_keyboard": filas}


def _texto_y_botones_detalle(p):
    texto = (
        f"<b>{p['simbolo']} · {p['tipo'].upper()}</b>\n"
        f"Ticket: {p['ticket']}\n"
        f"Volumen: {p['volumen']} · Apertura: {p['precio_apertura']} · Actual: {p['precio_actual']}\n"
        f"P/L: {round(p['profit'], 2)}\n"
        f"SL: {p.get('sl') or 'sin SL'} · TP: {p.get('tp') or 'sin TP'}"
    )
    botones = {
        "inline_keyboard": [
            [
                {"text": "🔴 Cerrar todo", "callback_data": f"cerrar:{p['ticket']}"},
                {"text": "🟡 Cerrar 50%", "callback_data": f"parcial50:{p['ticket']}"},
            ],
            [
                {"text": "🛡 Mover a BE", "callback_data": f"be:{p['ticket']}"},
            ],
            [
                {"text": "❌ Quitar SL", "callback_data": f"quitar_sl:{p['ticket']}"},
            ],
            [
                {"text": "✏️ Mover SL", "callback_data": f"pedirsl:{p['ticket']}"},
                {"text": "✏️ Mover TP", "callback_data": f"pedirtp:{p['ticket']}"},
            ],
            [
                {"text": "⬅ Volver a la lista", "callback_data": "volver"},
            ],
        ]
    }
    return texto, botones


def escuchar_comandos_operaciones(config_bot, responder, obtener_posiciones_abiertas,
                                   cerrar_posicion, cerrar_posicion_parcial,
                                   modificar_sl, modificar_tp,
                                   obtener_info_cuenta=None,
                                   obtener_historial_cerradas=None,
                                   deshabilitar_be_ticket=None,
                                   guardar_config=None,
                                   modificar_sl_masivo=None):
    """Long-polling de Telegram: procesa botones (callback_query) y mensajes
    normales de texto (usados solo para responder "¿cuál es el nuevo precio?").
    Nunca lanza excepción hacia afuera: si Telegram falla, reintenta solo.

    obtener_info_cuenta, obtener_historial_cerradas y deshabilitar_be_ticket
    son opcionales. Sin los dos primeros, Balance y Exportar historial avisan
    que no están disponibles; sin el último, Quitar SL funciona pero no puede
    impedir que la lógica automática vuelva a aplicar breakeven."""
    offset = None
    # Guarda, por chat, qué se le preguntó ("sl" o "tp" + ticket, o una
    # acción de bitácora/exportar pendiente) mientras espera la respuesta.
    pendiente_por_chat = {}
    saludo_enviado = False
    ultimo_error_polling = None
    print("Escuchador de menú de Telegram (operaciones) iniciado.")

    while True:
        token = config_bot.get("telegram_bot_token", "")
        chat_id_autorizado = str(config_bot.get("telegram_chat_id", ""))
        if not config_bot.get("telegram_activo") or not token or not chat_id_autorizado:
            time.sleep(15)
            continue

        if not saludo_enviado:
            resultado_saludo = _tg(token, "sendMessage", {
                "chat_id": chat_id_autorizado,
                "text": "Bot de control listo. Usa los botones de abajo.",
                "reply_markup": _teclado_principal(),
            })
            saludo_enviado = bool(resultado_saludo.get("ok"))

        try:
            params = {"timeout": 25}
            if offset is not None:
                params["offset"] = offset
            r = requests.get(f"https://api.telegram.org/bot{token}/getUpdates", params=params, timeout=30)
            datos = r.json()
            if not datos.get("ok"):
                descripcion = datos.get("description", "Telegram rechazó getUpdates sin más detalle.")
                if descripcion != ultimo_error_polling:
                    print(f"Error recibiendo comandos de Telegram: {descripcion}")
                    _tg(token, "sendMessage", {
                        "chat_id": chat_id_autorizado,
                        "text": (
                            "⚠️ No puedo recibir comandos de Telegram. "
                            f"Respuesta: {descripcion}\n"
                            "Si indica «Conflict», cierra cualquier otro proceso "
                            "que esté escuchando este mismo bot. Si indica webhook, "
                            "desactívalo para usar el menú local."
                        ),
                    })
                    ultimo_error_polling = descripcion
                time.sleep(5)
                continue

            if ultimo_error_polling:
                print("Conexión de recepción de comandos de Telegram restaurada.")
                ultimo_error_polling = None

            for update in datos.get("result", []):
                offset = update["update_id"] + 1

                callback = update.get("callback_query")
                if callback:
                    chat_id_origen = str(callback.get("message", {}).get("chat", {}).get("id", ""))
                    if chat_id_origen != chat_id_autorizado:
                        continue
                    _manejar_boton(
                        callback, token, chat_id_autorizado, pendiente_por_chat,
                        config_bot, obtener_posiciones_abiertas, cerrar_posicion,
                        cerrar_posicion_parcial, modificar_sl, modificar_tp,
                        obtener_info_cuenta, obtener_historial_cerradas,
                        deshabilitar_be_ticket, guardar_config, modificar_sl_masivo,
                    )
                    continue

                mensaje = update.get("message") or {}
                texto = (mensaje.get("text") or "").strip()
                chat_id_origen = str(mensaje.get("chat", {}).get("id", ""))
                if not texto or chat_id_origen != chat_id_autorizado:
                    continue

                if texto == "/be_detalle":
                    from backend.operaciones.riesgo import texto_detalle_be
                    _tg(token, "sendMessage", {
                        "chat_id": chat_id_autorizado, "text": texto_detalle_be(), "parse_mode": "HTML",
                    })
                    continue

                if texto in ("📊 Ver posiciones", "/posiciones", "/start", "/ayuda", "/help"):
                    try:
                        posiciones = obtener_posiciones_abiertas(simbolo=None)
                    except Exception as error:
                        _tg(token, "sendMessage", {
                            "chat_id": chat_id_autorizado,
                            "text": f"⚠️ No pude consultar las posiciones en MT5: {error}",
                        })
                        continue
                    texto_lista, botones = _texto_y_botones_lista(posiciones)
                    _tg(token, "sendMessage", {
                        "chat_id": chat_id_autorizado, "text": texto_lista, "parse_mode": "HTML",
                        "reply_markup": botones or _teclado_principal(),
                    })
                    continue

                if texto == "📈 Estadísticas":
                    _menu_estadisticas(token, chat_id_autorizado)
                    continue

                if texto == "📰 Noticias":
                    _menu_noticias(token, chat_id_autorizado, config_bot)
                    continue

                if texto == "🧰 Acciones posiciones":
                    _menu_acciones_posiciones(token, chat_id_autorizado)
                    continue

                if texto in ("🎯 Proyecciones", "/proyecciones"):
                    _menu_proyecciones(token, chat_id_autorizado)
                    continue

                if texto == "🧮 Calculadora":
                    _tg(token, "sendMessage", {
                        "chat_id": chat_id_autorizado, "parse_mode": "HTML",
                        "text": (
                            "<b>🧮 Calculadora</b>\n"
                            "Manda: <code>/calc entrada sl tp riesgo%</code>\n"
                            "Ej: <code>/calc 4200 4190 4230 1</code>\n"
                            "tp y riesgo% son opcionales (si no pones riesgo% usa el de tu config). "
                            "Para ver un cierre parcial agrega % y distancia: "
                            "<code>/calc 4200 4190 4230 1 50 15</code>"
                        ),
                    })
                    continue

                if texto.lower().startswith("/calc"):
                    _calcular_en_telegram(token, chat_id_autorizado, texto, config_bot, obtener_info_cuenta)
                    continue

                if texto == "🛡 Mover TODAS a BE":
                    _en_segundo_plano(
                        token, chat_id_autorizado, _mover_todas_a_be,
                        token, chat_id_autorizado, obtener_posiciones_abiertas,
                        modificar_sl, modificar_sl_masivo,
                    )
                    continue

                if texto == "📒 Bitácora":
                    _menu_bitacora(token, chat_id_autorizado)
                    continue

                if texto == "⏸ Pausar/Reanudar bot":
                    _alternar_bot(token, chat_id_autorizado, config_bot)
                    continue

                if texto == "💰 Balance":
                    _mostrar_balance(token, chat_id_autorizado, obtener_info_cuenta)
                    continue

                if texto == "🎚 Riesgo":
                    _menu_riesgo(token, chat_id_autorizado, config_bot)
                    continue

                if texto == "📤 Exportar historial":
                    _menu_exportar(token, chat_id_autorizado)
                    continue

                if texto == "🏦 Cuentas":
                    _menu_cuentas(token, chat_id_autorizado)
                    continue

                # Si había una pregunta pendiente (nuevo precio de SL/TP,
                # nota de bitácora, etc.), este mensaje de texto es la
                # respuesta.
                pendiente = pendiente_por_chat.get(chat_id_origen)
                if pendiente:
                    if texto.lower() in ("/cancel", "cancelar"):
                        pendiente_por_chat.pop(chat_id_origen, None)
                        _tg(token, "sendMessage", {"chat_id": chat_id_autorizado, "text": "Acción cancelada."})
                        continue
                    _resolver_pendiente(
                        texto, token, chat_id_autorizado, pendiente,
                        pendiente_por_chat, modificar_sl, modificar_tp,
                        obtener_posiciones_abiertas,
                    )
                    continue

                _tg(token, "sendMessage", {
                    "chat_id": chat_id_autorizado,
                    "text": "Usa los botones de abajo para operar.",
                    "reply_markup": _teclado_principal(),
                })

        except requests.RequestException as e:
            print("Error de red hablando con Telegram (comandos):", e)
            time.sleep(5)
        except Exception as e:
            print("Error inesperado en el escuchador de comandos:", e)
            time.sleep(5)


# ---- Proyecciones del Analista: ver, elegir cual operar y modo del bot ----
_PROY_CACHE = {}   # chat_id -> [(simbolo, clave)]; callback_data de Telegram admite solo 64 bytes


def _menu_proyecciones(token, chat_id):
    try:
        from backend.analista import api_config
        datos = api_config.obtener_proyecciones()
        todas = bool(api_config._leer().get("ejecucion", {}).get("todas_las_proyecciones"))
    except Exception as e:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"No pude leer las proyecciones: {e}"})
        return
    lineas = ["<b>🎯 Proyecciones del Analista</b>"]
    lineas.append("Escáner: " + ("activo" if datos["escaner"]["corriendo"] else "APAGADO (no se puede operar)"))
    lineas.append("Bot: " + (
        "automático · TODAS las proyecciones" if datos["ejecucion_activa"] and todas
        else "automático · solo activos marcados Operar" if datos["ejecucion_activa"]
        else "solo avisa; tú eliges"))
    cache, filas = [], []
    for a in datos["activos"]:
        if not a["escenarios"]:
            continue
        for e in a["escenarios"]:
            lado = "COMPRA" if e["direccion"] == "alcista" else "VENTA"
            marca = " ✅ ya operada" if e.get("ejecutada") else ""
            lineas.append(f"\n<b>{a['simbolo']}</b> {lado} · {e['estado']}{marca}\n"
                          f"Zona {e['zona']} {e['zona_tf']} · Entrada {e['entrada']} · SL {e['sl']}")
            if e["estado"] == "confirmada" and not e.get("ejecutada") and datos["manual_permitido"]:
                cache.append((a["simbolo"], e["clave"]))
                filas.append([{"text": f"▶ Operar {a['simbolo']} {lado}", "callback_data": f"proy:ver:{len(cache) - 1}"}])
    if len(lineas) == 3:
        lineas.append("\nSin oportunidades por ahora.")
    _PROY_CACHE[chat_id] = cache
    filas.append([{"text": "🤖 Bot: tomar TODAS" if not todas else "🙋 Bot: solo marcados",
                   "callback_data": "proy:modo:marcados" if todas else "proy:modo:todas"}])
    _tg(token, "sendMessage", {"chat_id": chat_id, "text": "\n".join(lineas), "parse_mode": "HTML",
                               "reply_markup": {"inline_keyboard": filas}})


def _manejar_proyeccion(data, token, chat_id):
    partes = data.split(":")
    try:
        if len(partes) == 3 and partes[1] == "modo":
            from backend.analista import api_config
            api_config.guardar_config({"config": {"ejecucion": {"todas_las_proyecciones": partes[2] == "todas"}}})
            _tg(token, "sendMessage", {"chat_id": chat_id, "text": (
                "Listo: el bot tomará TODAS las señales confirmadas (con paso 9 en automático)."
                if partes[2] == "todas" else
                "Listo: el bot solo tomará los activos marcados Operar; las demás las eliges tú.")})
            return
        if len(partes) == 3 and partes[1] in ("ver", "ok"):
            cache = _PROY_CACHE.get(chat_id) or []
            i = int(partes[2])
            if not 0 <= i < len(cache):
                _tg(token, "sendMessage", {"chat_id": chat_id, "text": "Esa lista ya venció; toca 🎯 Proyecciones otra vez."})
                return
            simbolo, clave = cache[i]
            if partes[1] == "ver":
                _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"¿Enviar a MT5 la señal confirmada de {simbolo}?",
                                           "reply_markup": {"inline_keyboard": [[
                                               {"text": "✅ Sí, operar", "callback_data": f"proy:ok:{i}"},
                                               {"text": "Cancelar", "callback_data": "proy:no:0"}]]}})
                return
            from fastapi import HTTPException
            from backend.analista import api_config
            try:
                r = api_config.operar_proyeccion({"simbolo": simbolo, "clave": clave})
                texto = " · ".join(r["resultados"]) or "Sin resultado."
            except HTTPException as e:
                texto = f"No se operó: {e.detail}"
            _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"[{simbolo}] {texto}"})
            return
        if len(partes) == 3 and partes[1] == "no":
            _tg(token, "sendMessage", {"chat_id": chat_id, "text": "Cancelado; no se envió ninguna orden."})
    except Exception as e:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"Error en proyecciones: {e}"})


# --- Ejecución en segundo plano de los BE masivos ---------------------------
# El bucle de Telegram es un solo hilo: antes, "Mover TODAS a BE" corría ahí
# dentro y, con muchas posiciones (o el candado de MT5 ocupado), el bot dejaba
# de responder y el aviso llegaba tarde. Ahora se responde al instante
# («⏳ Moviendo…») y el trabajo corre en otro hilo; un candado evita que dos
# toques seguidos lancen el mismo BE dos veces.
_be_en_curso = threading.Lock()


def _en_segundo_plano(token, chat_id, funcion, *args, **kwargs):
    if not _be_en_curso.acquire(blocking=False):
        _tg(token, "sendMessage", {
            "chat_id": chat_id,
            "text": "⏳ Ya hay un movimiento a BE en curso; espera su resumen.",
        })
        return
    _tg(token, "sendMessage", {"chat_id": chat_id, "text": "⏳ Moviendo a BE…"})

    def _trabajo():
        try:
            funcion(*args, **kwargs)
        except Exception as error:
            _tg(token, "sendMessage", {
                "chat_id": chat_id,
                "text": f"⚠️ Falló el movimiento a BE: {error}",
            })
        finally:
            _be_en_curso.release()

    threading.Thread(target=_trabajo, daemon=True).start()



def _resultados_sl_masivos(posiciones, modificar_sl, modificar_sl_masivo=None):
    if modificar_sl_masivo is not None:
        return modificar_sl_masivo(posiciones)
    return {
        p["ticket"]: modificar_sl(p["ticket"], p["precio_apertura"])
        for p in posiciones
    }


def _sl_ya_protege_be(posicion):
    sl = float(posicion.get("sl") or 0)
    if sl <= 0:
        return False
    entrada = float(posicion["precio_apertura"])
    if posicion["tipo"] == "compra":
        return sl >= entrada
    return sl <= entrada


def _resumen_resultados_be(posiciones, resultados, protegidas=0):
    movidas = []
    errores = defaultdict(list)
    for posicion in posiciones:
        resultado = resultados.get(
            posicion["ticket"],
            {"ok": False, "error": "No se recibió resultado para la posición."},
        )
        etiqueta = f"{posicion['simbolo']} #{posicion['ticket']}"
        if resultado.get("ok"):
            movidas.append(etiqueta)
        else:
            error = str(resultado.get("error", "error desconocido"))[:180]
            errores[error].append(etiqueta)

    texto = f"🛡 BE: {len(movidas)} movida(s); {protegidas} ya tenían BE o mejor."
    if errores:
        fallidas = sum(len(tickets) for tickets in errores.values())
        texto += f"\n⚠️ Fallidas: {fallidas}."
        ordenados = sorted(errores.items(), key=lambda item: -len(item[1]))
        for error, tickets in ordenados[:8]:
            muestra = ", ".join(tickets[:4])
            if len(tickets) > 4:
                muestra += f", +{len(tickets) - 4} más"
            texto += f"\n{len(tickets)}× {error}\n{muestra}"
        if len(ordenados) > 8:
            texto += f"\nOtros motivos: {len(ordenados) - 8}."
    return texto


def _mover_todas_a_be(token, chat_id, obtener_posiciones_abiertas, modificar_sl,
                      modificar_sl_masivo=None):
    try:
        posiciones = obtener_posiciones_abiertas(simbolo=None)
    except Exception as error:
        _tg(token, "sendMessage", {
            "chat_id": chat_id,
            "text": f"⚠️ No pude consultar las posiciones en MT5; no se modificó ninguna: {error}",
        })
        return
    en_ganancia = [p for p in posiciones if p["profit"] > 0]
    pendientes = [p for p in en_ganancia if not _sl_ya_protege_be(p)]
    protegidas = len(en_ganancia) - len(pendientes)
    if not pendientes:
        texto = (
            "Todas las operaciones rentables ya tienen el SL en BE o mejor."
            if protegidas else
            "No hay operaciones en ganancia ahora mismo."
        )
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": texto})
        return
    resultados = _resultados_sl_masivos(pendientes, modificar_sl, modificar_sl_masivo)
    texto = _resumen_resultados_be(pendientes, resultados, protegidas)
    _tg(token, "sendMessage", {"chat_id": chat_id, "text": texto})


def _menu_noticias(token, chat_id, config_bot):
    bloqueo_activo = config_bot.get("bloqueo_noticias_activo", True)
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": (
            f"<b>📰 Bloqueo por noticias: {'ACTIVO' if bloqueo_activo else 'INACTIVO'}</b>\n"
            "Las noticias no mueven posiciones a BE ni las cierran. "
            "El BE automático solo se activa con zona macro y la secuencia "
            "impulso-retroceso-ruptura confirmada en una temporalidad micro."
        ),
        "parse_mode": "HTML",
    })


def _seleccionar_modo_noticias(token, chat_id, config_bot, modo, guardar_config):
    anteriores = (
        config_bot.get("bloqueo_noticias_activo", True),
        config_bot.get("noticia_be_activo", True),
    )
    config_bot["bloqueo_noticias_activo"] = True
    config_bot["noticia_be_activo"] = False
    if guardar_config is not None:
        try:
            guardar_config()
        except Exception as error:
            config_bot["bloqueo_noticias_activo"], config_bot["noticia_be_activo"] = anteriores
            _tg(token, "sendMessage", {
                "chat_id": chat_id,
                "text": f"No se pudo guardar la configuración de noticias: {error}",
            })
            return
    nombre = "AUTOMÁTICO" if modo == "auto" else "MANUAL"
    detalle = (
        "Se bloquearán entradas nuevas. Las noticias no mueven posiciones a BE; "
        "el BE automático requiere la secuencia estructural confirmada."
    )
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": f"✅ Modo de noticias {nombre} activado.\n{detalle}\nNo se cerrarán operaciones por noticias.",
    })


def _menu_acciones_posiciones(token, chat_id):
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": "<b>🧰 Acciones sobre posiciones</b>\nElige una acción:",
        "parse_mode": "HTML",
        "reply_markup": {"inline_keyboard": [
            [{"text": "🔴 Cerrar posiciones", "callback_data": "bulk:scope:close"}],
            [{"text": "🛡 Mover a BE", "callback_data": "bulk:scope:be"}],
            [{"text": "✏️ Cambiar SL de un activo", "callback_data": "bulk:symbols:sl"}],
        ]},
    })


def _menu_filtro_masivo(token, chat_id, accion):
    filas = [
        [{"text": "Todas", "callback_data": f"bulk:apply:{accion}:all:*:*"}],
        [{"text": "Solo BUY", "callback_data": f"bulk:apply:{accion}:all:*:compra"}],
        [{"text": "Solo SELL", "callback_data": f"bulk:apply:{accion}:all:*:venta"}],
        [{"text": "Elegir activo", "callback_data": f"bulk:symbols:{accion}"}],
    ]
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": "Selecciona qué posiciones incluir:",
        "reply_markup": {"inline_keyboard": filas},
    })


def _menu_activos_masivo(token, chat_id, accion, obtener_posiciones_abiertas):
    simbolos = sorted({
        p["simbolo"] for p in obtener_posiciones_abiertas(simbolo=None)
        if p.get("simbolo")
    })
    if not simbolos:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "No hay operaciones abiertas."})
        return
    filas = [[{
        "text": simbolo,
        "callback_data": f"bulk:asset:{accion}:{simbolo}",
    }] for simbolo in simbolos]
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": "Elige el activo:",
        "reply_markup": {"inline_keyboard": filas},
    })


def _menu_direccion_activo(token, chat_id, accion, simbolo):
    direcciones = [
        [{"text": "Solo BUY", "callback_data": f"bulk:apply:{accion}:asset:{simbolo}:compra"}],
        [{"text": "Solo SELL", "callback_data": f"bulk:apply:{accion}:asset:{simbolo}:venta"}],
    ]
    if accion != "sl":
        direcciones.insert(
            0,
            [{"text": "Todas", "callback_data": f"bulk:apply:{accion}:asset:{simbolo}:*"}],
        )
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": (
            f"Activo: {simbolo}. Elige la dirección:"
            if accion == "sl" else
            f"Activo: {simbolo}. ¿Qué posiciones incluir?"
        ),
        "reply_markup": {"inline_keyboard": direcciones},
    })


def _posiciones_filtradas(obtener_posiciones_abiertas, simbolo=None, tipo=None):
    posiciones = obtener_posiciones_abiertas(simbolo=None)
    if simbolo:
        posiciones = [p for p in posiciones if p.get("simbolo") == simbolo]
    if tipo:
        posiciones = [p for p in posiciones if p.get("tipo") == tipo]
    return posiciones


def _solicitar_sl_masivo(token, chat_id, pendiente_por_chat, simbolo, tipo,
                         obtener_posiciones_abiertas):
    posiciones = _posiciones_filtradas(obtener_posiciones_abiertas, simbolo, tipo)
    if not posiciones:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "No hay posiciones que coincidan con ese filtro."})
        return
    pendiente_por_chat[chat_id] = {
        "accion": "sl_masivo", "simbolo": simbolo, "tipo": tipo,
    }
    direccion = f" {tipo.upper()}" if tipo else ""
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": (
            f"Escribe el nuevo precio de SL para {simbolo}{direccion} "
            f"({len(posiciones)} posición(es)). Se aplicará a todas las que "
            "sigan coincidiendo con el filtro. Envía /cancel para cancelar."
        ),
    })


def _confirmar_cierre_masivo(token, chat_id, simbolo, tipo,
                             obtener_posiciones_abiertas):
    posiciones = _posiciones_filtradas(obtener_posiciones_abiertas, simbolo, tipo)
    if not posiciones:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "No hay posiciones que coincidan con ese filtro."})
        return
    simbolo_data = simbolo or "*"
    tipo_data = tipo or "*"
    filtro = f"{simbolo or 'todos los activos'} · {tipo.upper() if tipo else 'BUY y SELL'}"
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": f"⚠️ ¿Confirmas cerrar {len(posiciones)} posición(es)?\nFiltro: {filtro}",
        "reply_markup": {"inline_keyboard": [[
            {"text": "Sí, cerrar", "callback_data": f"bulk:close_yes:{simbolo_data}:{tipo_data}"},
            {"text": "Cancelar", "callback_data": "bulk:close_no"},
        ]]},
    })


def _ejecutar_masivo(token, chat_id, accion, simbolo, tipo,
                     obtener_posiciones_abiertas, cerrar_posicion, modificar_sl,
                     modificar_sl_masivo=None):
    try:
        posiciones = _posiciones_filtradas(obtener_posiciones_abiertas, simbolo, tipo)
    except Exception as error:
        _tg(token, "sendMessage", {
            "chat_id": chat_id,
            "text": f"⚠️ No pude consultar las posiciones en MT5; no se modificó ninguna: {error}",
        })
        return
    if accion == "be":
        posiciones = [p for p in posiciones if p.get("profit", 0) > 0]
        if not posiciones:
            _tg(token, "sendMessage", {
                "chat_id": chat_id,
                "text": "No hay posiciones en ganancia que coincidan con ese filtro.",
            })
            return

    resultados_be = {}
    protegidas_be = 0
    if accion == "be":
        pendientes_be = [p for p in posiciones if not _sl_ya_protege_be(p)]
        protegidas_be = len(posiciones) - len(pendientes_be)
        if not pendientes_be:
            _tg(token, "sendMessage", {
                "chat_id": chat_id,
                "text": "Todas las posiciones rentables ya tienen el SL en BE o mejor.",
            })
            return
        resultados_be = _resultados_sl_masivos(
            pendientes_be, modificar_sl, modificar_sl_masivo,
        )
        _tg(token, "sendMessage", {
            "chat_id": chat_id,
            "text": _resumen_resultados_be(pendientes_be, resultados_be, protegidas_be),
        })
        return

    exitosas, fallidas = [], []
    for posicion in posiciones:
        resultado = cerrar_posicion(posicion["ticket"])
        etiqueta = f"{posicion['simbolo']} {posicion['tipo'].upper()} #{posicion['ticket']}"
        if resultado.get("ok"):
            exitosas.append(etiqueta)
        else:
            fallidas.append(f"{etiqueta}: {resultado.get('error', 'error desconocido')}")

    accion_txt = "movidas a BE" if accion == "be" else "cerradas"
    lineas = [f"✅ {len(exitosas)} posición(es) {accion_txt}."]
    if exitosas:
        lineas.extend(exitosas)
    if fallidas:
        lineas.append("\nNo se pudieron procesar:")
        lineas.extend(fallidas)
    _tg(token, "sendMessage", {"chat_id": chat_id, "text": "\n".join(lineas)})


def _buscar_posicion(ticket, obtener_posiciones_abiertas):
    for p in obtener_posiciones_abiertas(simbolo=None):
        if p["ticket"] == ticket:
            return p
    return None


def _editar_a_lista(token, chat_id, message_id, obtener_posiciones_abiertas):
    posiciones = obtener_posiciones_abiertas(simbolo=None)
    texto, botones = _texto_y_botones_lista(posiciones)
    _tg(token, "editMessageText", {
        "chat_id": chat_id, "message_id": message_id, "text": texto,
        "parse_mode": "HTML", "reply_markup": botones or {"inline_keyboard": []},
    })


# ============================================================
# 📒 BITÁCORA
# ============================================================
def _menu_bitacora(token, chat_id):
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": "<b>Bitácora</b>\n¿Qué quieres hacer?",
        "parse_mode": "HTML",
        "reply_markup": {
            "inline_keyboard": [
                [{"text": "🗒 Ver últimas notas", "callback_data": "bitnotas"}],
                [{"text": "🗑 Borrar TODO el historial", "callback_data": "bitborrar_pedir"}],
            ]
        },
    })


def _ver_ultimas_notas(token, chat_id):
    from backend.operaciones import estadisticas as stats
    entradas = stats.cargar_bitacora()
    if not entradas:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "La bitácora está vacía."})
        return
    import datetime
    lineas = ["<b>Últimas notas de la bitácora</b>", ""]
    for e in entradas[:15]:
        fecha = datetime.datetime.fromtimestamp(e["hora"]).strftime("%d/%m %H:%M")
        ticket_txt = f" (ticket {e['ticket']})" if e.get("ticket") else ""
        lineas.append(f"• {fecha}{ticket_txt}: {e['nota']}")
    _tg(token, "sendMessage", {"chat_id": chat_id, "text": "\n".join(lineas), "parse_mode": "HTML"})


def _pedir_confirmacion_borrar(token, chat_id):
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": "⚠ Esto borra TODAS las notas de la bitácora y no se puede deshacer. ¿Seguro?",
        "reply_markup": {
            "inline_keyboard": [[
                {"text": "✅ Sí, borrar todo", "callback_data": "bitborrar_si"},
                {"text": "❌ Cancelar", "callback_data": "bitborrar_no"},
            ]]
        },
    })


def _borrar_bitacora(token, chat_id):
    from backend.operaciones import estadisticas as stats
    stats.guardar_bitacora([])
    _tg(token, "sendMessage", {"chat_id": chat_id, "text": "🗑 Bitácora borrada por completo."})


# ============================================================
# ⏸ PAUSAR / REANUDAR
# ============================================================
def _alternar_bot(token, chat_id, config_bot):
    config_bot["activo"] = not config_bot.get("activo", True)
    if config_bot["activo"]:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "▶️ Bot REANUDADO: el trading automático sigue activo de nuevo."})
    else:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "⏸ Bot PAUSADO: no se abrirán nuevas operaciones hasta que lo reanudes."})


# ============================================================
# 💰 BALANCE
# ============================================================
def _mostrar_balance(token, chat_id, obtener_info_cuenta):
    if obtener_info_cuenta is None:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "No tengo forma de leer el balance en este proceso."})
        return
    info = obtener_info_cuenta()
    if info is None:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "No se pudo leer el balance (¿MT5 está conectado?)."})
        return
    texto = (
        f"<b>💰 Cuenta {info['cuenta']}</b> · {info['servidor']}\n"
        f"{'REAL' if info['es_real'] else 'DEMO'}\n\n"
        f"Balance: {info['balance']} {info['moneda']}\n"
        f"Equity: {info['equity']} {info['moneda']}\n"
        f"P/L flotante: {round(info['profit'], 2)} {info['moneda']}\n"
        f"Margen libre: {info['margen_libre']} {info['moneda']}\n"
        f"Apalancamiento: 1:{info['apalancamiento']}"
    )
    _tg(token, "sendMessage", {"chat_id": chat_id, "text": texto, "parse_mode": "HTML"})


# ============================================================
# 🎚 RIESGO
# ============================================================
_PRESETS_RIESGO = [0.5, 1.0, 1.5, 2.0, 3.0]


def _menu_riesgo(token, chat_id, config_bot):
    modo = config_bot.get("modo_riesgo")
    valor = config_bot.get("riesgo_valor")
    actual = f"Modo actual: {modo} · Valor: {valor}" if modo else "Modo actual: no configurado"
    filas = [[{"text": f"{p}%", "callback_data": f"riesgo:{p}"} for p in _PRESETS_RIESGO[:3]],
             [{"text": f"{p}%", "callback_data": f"riesgo:{p}"} for p in _PRESETS_RIESGO[3:]]]
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": f"<b>🎚 Riesgo por operación</b>\n{actual}\n\nElige el % del balance a arriesgar por operación:",
        "parse_mode": "HTML",
        "reply_markup": {"inline_keyboard": filas},
    })


def _aplicar_riesgo(token, chat_id, config_bot, valor):
    config_bot["modo_riesgo"] = "porcentaje"
    config_bot["riesgo_valor"] = valor
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": f"✅ Riesgo actualizado: {valor}% del balance por operación (modo porcentaje).",
    })


# ============================================================
# 📤 EXPORTAR HISTORIAL
# ============================================================
_PRESETS_DIAS = [7, 30, 90, 365]


def _menu_exportar(token, chat_id):
    filas = [[{"text": f"Últimos {d} días" if d != 365 else "Todo (365 días)", "callback_data": f"exp:{d}"}] for d in _PRESETS_DIAS]
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": "<b>📤 Exportar historial</b>\n¿De cuántos días quieres el CSV?",
        "parse_mode": "HTML",
        "reply_markup": {"inline_keyboard": filas},
    })


def _exportar_csv(token, chat_id, obtener_historial_cerradas, dias):
    if obtener_historial_cerradas is None:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "No tengo forma de leer el historial en este proceso."})
        return
    deals = obtener_historial_cerradas(dias=dias, simbolo=None)
    if not deals:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"No hay operaciones cerradas en los últimos {dias} días."})
        return

    import datetime
    buffer = io.StringIO()
    columnas = ["ticket", "simbolo", "tipo", "volumen", "precio", "profit", "hora", "reason"]
    writer = csv.DictWriter(buffer, fieldnames=columnas, extrasaction="ignore")
    writer.writeheader()
    for d in deals:
        fila = dict(d)
        fila["hora"] = datetime.datetime.fromtimestamp(d["hora"]).strftime("%Y-%m-%d %H:%M:%S")
        writer.writerow(fila)

    nombre = f"historial_{dias}dias_{datetime.date.today().isoformat()}.csv"
    _tg_documento(token, chat_id, nombre, buffer.getvalue(), caption=f"📤 {len(deals)} operación(es) de los últimos {dias} días.")


# ============================================================
# 🏦 CUENTAS (multicuenta)
# ============================================================
def _cargar_multicuenta():
    try:
        from backend.integraciones import multicuenta as cuentas_mod
    except ImportError:
        import multicuenta as cuentas_mod
    return cuentas_mod


def _menu_cuentas(token, chat_id):
    try:
        cuentas_mod = _cargar_multicuenta()
        cuentas = cuentas_mod.listar_cuentas()
    except Exception as e:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"No se pudo leer backend/datos/cuentas.json: {e}"})
        return
    if not cuentas:
        _tg(token, "sendMessage", {
            "chat_id": chat_id,
            "text": "No tienes cuentas registradas en multicuenta.\nRegistra una con: python -m backend.multicuenta agregar",
        })
        return

    filas = []
    for c in cuentas:
        estado_txt = "…"
        try:
            r = requests.get(f"http://127.0.0.1:{c['puerto']}/api/estado", timeout=3)
            if r.ok:
                activo = r.json().get("config", {}).get("activo")
                estado_txt = "🟢 operando" if activo else "🟡 pausada"
            else:
                estado_txt = "⚪ sin conexión"
        except requests.RequestException:
            estado_txt = "⚪ sin conexión"
        filas.append([{
            "text": f"{c['id']} ({c['nombre']}) · {estado_txt}",
            "callback_data": f"cta_ver:{c['id']}",
        }])
    _tg(token, "sendMessage", {
        "chat_id": chat_id,
        "text": "<b>🏦 Cuentas registradas</b>\nToca una para activarla/pausarla:",
        "parse_mode": "HTML",
        "reply_markup": {"inline_keyboard": filas},
    })


def _alternar_cuenta(token, chat_id, id_cuenta):
    cuentas_mod = _cargar_multicuenta()
    cuenta = cuentas_mod.obtener_cuenta(id_cuenta)
    if cuenta is None:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"No existe la cuenta '{id_cuenta}'."})
        return
    base_url = f"http://127.0.0.1:{cuenta['puerto']}"
    try:
        r = requests.get(f"{base_url}/api/estado", timeout=5)
        activo_actual = r.json().get("config", {}).get("activo", True) if r.ok else True
        nuevo = not activo_actual
        requests.post(f"{base_url}/api/config", json={"activo": nuevo}, timeout=5)
        estado_txt = "ACTIVADA ▶️" if nuevo else "PAUSADA ⏸"
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"Cuenta '{id_cuenta}': {estado_txt}"})
    except requests.RequestException as e:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"No se pudo contactar el proceso de '{id_cuenta}' (¿está corriendo en el puerto {cuenta['puerto']}?): {e}"})


def _manejar_boton(callback, token, chat_id, pendiente_por_chat, config_bot,
                    obtener_posiciones_abiertas, cerrar_posicion,
                    cerrar_posicion_parcial, modificar_sl, modificar_tp,
                    obtener_info_cuenta, obtener_historial_cerradas,
                    deshabilitar_be_ticket=None, guardar_config=None,
                    modificar_sl_masivo=None):
    data = callback.get("data", "")
    callback_id = callback.get("id")
    message_id = callback.get("message", {}).get("message_id")
    # Siempre hay que "contestar" el callback o el botón se queda "cargando"
    # en el celular de la persona.
    _tg(token, "answerCallbackQuery", {"callback_query_id": callback_id})

    if data == "volver":
        _editar_a_lista(token, chat_id, message_id, obtener_posiciones_abiertas)
        return

    if data.startswith("proy:"):
        _manejar_proyeccion(data, token, chat_id)
        return

    if data == "news:auto":
        _seleccionar_modo_noticias(token, chat_id, config_bot, "auto", guardar_config)
        return

    if data == "news:manual":
        _seleccionar_modo_noticias(token, chat_id, config_bot, "manual", guardar_config)
        return

    if data == "bulk:close_no":
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "Cierre cancelado; no se modificó ninguna posición."})
        return

    if data.startswith("bulk:"):
        partes = data.split(":")
        if len(partes) == 3 and partes[1] == "scope":
            _menu_filtro_masivo(token, chat_id, partes[2])
            return
        if len(partes) == 3 and partes[1] == "symbols":
            _menu_activos_masivo(token, chat_id, partes[2], obtener_posiciones_abiertas)
            return
        if len(partes) == 4 and partes[1] == "asset":
            _, _, accion, simbolo = partes
            _menu_direccion_activo(token, chat_id, accion, simbolo)
            return
        if len(partes) == 6 and partes[1] == "apply":
            _, _, accion, alcance, simbolo_txt, tipo_txt = partes
            simbolo = simbolo_txt if alcance == "asset" else None
            tipo = tipo_txt if tipo_txt in ("compra", "venta") else None
            if accion == "sl":
                if not simbolo:
                    _tg(token, "sendMessage", {
                        "chat_id": chat_id,
                        "text": "Para cambiar SL selecciona primero un solo activo.",
                    })
                    return
                _solicitar_sl_masivo(
                    token, chat_id, pendiente_por_chat, simbolo, tipo,
                    obtener_posiciones_abiertas,
                )
            elif accion == "close":
                _confirmar_cierre_masivo(
                    token, chat_id, simbolo, tipo, obtener_posiciones_abiertas,
                )
            elif accion == "be":
                _en_segundo_plano(
                    token, chat_id, _ejecutar_masivo,
                    token, chat_id, accion, simbolo, tipo,
                    obtener_posiciones_abiertas, cerrar_posicion, modificar_sl,
                    modificar_sl_masivo,
                )
            return
        if len(partes) == 4 and partes[1] == "close_yes":
            simbolo = partes[2] if partes[2] != "*" else None
            tipo = partes[3] if partes[3] in ("compra", "venta") else None
            _ejecutar_masivo(
                token, chat_id, "close", simbolo, tipo,
                obtener_posiciones_abiertas, cerrar_posicion, modificar_sl,
                modificar_sl_masivo,
            )
            return
        return

    if data.startswith("est:"):
        _mostrar_estadisticas(token, chat_id, obtener_historial_cerradas, obtener_info_cuenta, int(data.split(":", 1)[1]))
        return

    if data == "bitnotas":
        _ver_ultimas_notas(token, chat_id)
        return

    if data == "bitborrar_pedir":
        _pedir_confirmacion_borrar(token, chat_id)
        return

    if data == "bitborrar_si":
        _borrar_bitacora(token, chat_id)
        return

    if data == "bitborrar_no":
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "Cancelado, no se borró nada."})
        return

    if data.startswith("riesgo:"):
        valor = float(data.split(":", 1)[1])
        _aplicar_riesgo(token, chat_id, config_bot, valor)
        return

    if data.startswith("exp:"):
        dias = int(data.split(":", 1)[1])
        _exportar_csv(token, chat_id, obtener_historial_cerradas, dias)
        return

    if data.startswith("cta_ver:"):
        id_cuenta = data.split(":", 1)[1]
        _alternar_cuenta(token, chat_id, id_cuenta)
        return

    if ":" not in data:
        return
    accion, ticket_txt = data.split(":", 1)
    try:
        ticket = int(ticket_txt)
    except ValueError:
        return

    if accion == "ver":
        posicion = _buscar_posicion(ticket, obtener_posiciones_abiertas)
        if posicion is None:
            _tg(token, "answerCallbackQuery", {"callback_query_id": callback_id, "text": "Esa operación ya no está abierta.", "show_alert": True})
            _editar_a_lista(token, chat_id, message_id, obtener_posiciones_abiertas)
            return
        texto, botones = _texto_y_botones_detalle(posicion)
        _tg(token, "editMessageText", {
            "chat_id": chat_id, "message_id": message_id, "text": texto,
            "parse_mode": "HTML", "reply_markup": botones,
        })
        return

    if accion == "cerrar":
        resultado = cerrar_posicion(ticket)
        aviso = f"✅ Ticket {ticket} cerrado." if resultado.get("ok") else f"❌ No se pudo cerrar {ticket}: {resultado.get('error')}"
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": aviso})
        _editar_a_lista(token, chat_id, message_id, obtener_posiciones_abiertas)
        return

    if accion == "parcial50":
        posicion = _buscar_posicion(ticket, obtener_posiciones_abiertas)
        if posicion is None:
            _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"No encontré el ticket {ticket} abierto."})
            return
        mitad = round(posicion["volumen"] / 2, 2)
        resultado = cerrar_posicion_parcial(ticket, mitad)
        aviso = f"✅ Cerrado 50% ({mitad} lotes) del ticket {ticket}." if resultado.get("ok") else f"❌ No se pudo: {resultado.get('error')}"
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": aviso})
        posicion_actualizada = _buscar_posicion(ticket, obtener_posiciones_abiertas)
        if posicion_actualizada:
            texto, botones = _texto_y_botones_detalle(posicion_actualizada)
            _tg(token, "editMessageText", {
                "chat_id": chat_id, "message_id": message_id, "text": texto,
                "parse_mode": "HTML", "reply_markup": botones,
            })
        else:
            _editar_a_lista(token, chat_id, message_id, obtener_posiciones_abiertas)
        return

    if accion == "be":
        posicion = _buscar_posicion(ticket, obtener_posiciones_abiertas)
        if posicion is None:
            _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"No encontré el ticket {ticket} abierto."})
            return
        resultado = modificar_sl(ticket, posicion["precio_apertura"])
        aviso = (f"✅ SL de {ticket} movido a breakeven ({posicion['precio_apertura']})."
                 if resultado.get("ok") else f"❌ No se pudo: {resultado.get('error')}")
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": aviso})
        return

    if accion == "quitar_sl":
        posicion = _buscar_posicion(ticket, obtener_posiciones_abiertas)
        if posicion is None:
            _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"No encontré el ticket {ticket} abierto."})
            return
        if not posicion.get("sl"):
            _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"El ticket {ticket} ya está sin SL."})
            return
        _tg(token, "editMessageText", {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": (
                f"⚠️ <b>Quitar el stop loss del ticket {ticket}?</b>\n"
                "La operación quedará sin protección por SL y puede generar pérdidas mayores."
            ),
            "parse_mode": "HTML",
            "reply_markup": {
                "inline_keyboard": [[
                    {"text": "⚠️ Sí, quitar SL", "callback_data": f"quitar_sl_si:{ticket}"},
                    {"text": "Cancelar", "callback_data": f"ver:{ticket}"},
                ]]
            },
        })
        return

    if accion == "quitar_sl_si":
        posicion = _buscar_posicion(ticket, obtener_posiciones_abiertas)
        if posicion is None:
            _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"No encontré el ticket {ticket} abierto."})
            _editar_a_lista(token, chat_id, message_id, obtener_posiciones_abiertas)
            return
        if not posicion.get("sl"):
            _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"El ticket {ticket} ya está sin SL."})
            texto, botones = _texto_y_botones_detalle(posicion)
            _tg(token, "editMessageText", {
                "chat_id": chat_id, "message_id": message_id, "text": texto,
                "parse_mode": "HTML", "reply_markup": botones,
            })
            return
        resultado = modificar_sl(ticket, 0.0)
        if resultado.get("ok"):
            if deshabilitar_be_ticket is not None:
                deshabilitar_be_ticket(ticket)
            aviso = f"⚠️ SL quitado del ticket {ticket}. La operación quedó sin stop loss."
        else:
            aviso = f"❌ No se pudo quitar el SL de {ticket}: {resultado.get('error')}"
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": aviso})
        posicion_actualizada = _buscar_posicion(ticket, obtener_posiciones_abiertas)
        if posicion_actualizada:
            texto, botones = _texto_y_botones_detalle(posicion_actualizada)
            _tg(token, "editMessageText", {
                "chat_id": chat_id, "message_id": message_id, "text": texto,
                "parse_mode": "HTML", "reply_markup": botones,
            })
        else:
            _editar_a_lista(token, chat_id, message_id, obtener_posiciones_abiertas)
        return

    if accion == "pedirsl":
        pendiente_por_chat[chat_id] = {"accion": "sl", "ticket": ticket}
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"Escribe el nuevo precio de SL para el ticket {ticket} (solo el número):"})
        return

    if accion == "pedirtp":
        pendiente_por_chat[chat_id] = {"accion": "tp", "ticket": ticket}
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"Escribe el nuevo precio de TP para el ticket {ticket} (solo el número):"})
        return


def _resolver_pendiente(texto, token, chat_id, pendiente, pendiente_por_chat,
                         modificar_sl, modificar_tp,
                         obtener_posiciones_abiertas=None):
    texto_limpio = texto.replace(",", ".").strip()
    try:
        precio = float(texto_limpio)
    except ValueError:
        _tg(token, "sendMessage", {
            "chat_id": chat_id,
            "text": "Eso no es un precio válido. Escribe un número o envía /cancel.",
        })
        return

    if pendiente["accion"] == "sl_masivo":
        if not math.isfinite(precio) or precio <= 0 or obtener_posiciones_abiertas is None:
            _tg(token, "sendMessage", {
                "chat_id": chat_id,
                "text": "El SL debe ser mayor que cero. Escribe otro precio o envía /cancel.",
            })
            return
        posiciones = _posiciones_filtradas(
            obtener_posiciones_abiertas,
            pendiente["simbolo"],
            pendiente.get("tipo"),
        )
        if not posiciones:
            pendiente_por_chat.pop(chat_id, None)
            _tg(token, "sendMessage", {
                "chat_id": chat_id,
                "text": "Ya no hay posiciones que coincidan con ese filtro.",
            })
            return
        pendiente_por_chat.pop(chat_id, None)
        exitosas, fallidas = [], []
        for posicion in posiciones:
            resultado = modificar_sl(posicion["ticket"], precio)
            etiqueta = f"{posicion['simbolo']} {posicion['tipo'].upper()} #{posicion['ticket']}"
            if resultado.get("ok"):
                exitosas.append(etiqueta)
            else:
                fallidas.append(f"{etiqueta}: {resultado.get('error', 'error desconocido')}")
        lineas = [f"✅ SL actualizado a {precio} en {len(exitosas)} posición(es)."]
        if exitosas:
            lineas.extend(exitosas)
        if fallidas:
            lineas.append("\nNo se pudo actualizar:")
            lineas.extend(fallidas)
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "\n".join(lineas)})
        return

    pendiente_por_chat.pop(chat_id, None)
    ticket = pendiente["ticket"]
    if pendiente["accion"] == "sl":
        resultado = modificar_sl(ticket, precio)
        texto_resp = f"✅ SL de {ticket} movido a {precio}." if resultado.get("ok") else f"❌ No se pudo: {resultado.get('error')}"
    else:
        resultado = modificar_tp(ticket, precio)
        texto_resp = f"✅ TP de {ticket} movido a {precio}." if resultado.get("ok") else f"❌ No se pudo: {resultado.get('error')}"
    _tg(token, "sendMessage", {"chat_id": chat_id, "text": texto_resp})


# ============================================================
# 📈 ESTADÍSTICAS  y  🧮 CALCULADORA
# ============================================================
def _menu_estadisticas(token, chat_id):
    _tg(token, "sendMessage", {
        "chat_id": chat_id, "text": "<b>📈 Estadísticas</b>\n¿De qué periodo?", "parse_mode": "HTML",
        "reply_markup": {"inline_keyboard": [[
            {"text": "Hoy", "callback_data": "est:1"},
            {"text": "7 días", "callback_data": "est:7"},
            {"text": "30 días", "callback_data": "est:30"},
            {"text": "Todo (1 año)", "callback_data": "est:365"},
        ]]},
    })


def _mostrar_estadisticas(token, chat_id, obtener_historial_cerradas, obtener_info_cuenta, dias):
    from backend.operaciones import estadisticas as stats
    if obtener_historial_cerradas is None:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "No tengo acceso al historial en este proceso."})
        return
    deals = [d for d in obtener_historial_cerradas(dias=dias, simbolo=None) if d.get("profit") is not None]
    if not deals:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": f"Sin operaciones cerradas en los últimos {dias} día(s)."})
        return
    e = stats.calcular_estadisticas(deals)
    info = obtener_info_cuenta() if obtener_info_cuenta else None
    moneda = info["moneda"] if info else ""
    crecimiento = ""
    if info and info.get("balance"):
        inicial = info["balance"] - e["ganancia_total"]
        if inicial > 0:
            crecimiento = f"Crecimiento del periodo: {e['ganancia_total'] / inicial * 100:+.2f}%\n"
    racha = e["racha_actual"]
    racha_txt = f"{abs(racha)} {'ganadora(s)' if racha > 0 else 'perdedora(s)'} seguida(s)" if racha else "—"
    pf = e["profit_factor"] if e["profit_factor"] is not None else "∞"
    ratio = e["ratio_ganancia_perdida"] if e["ratio_ganancia_perdida"] is not None else "—"
    texto = (
        f"<b>📈 Estadísticas · últimos {dias} día(s)</b>\n\n"
        f"Operaciones: {e['total_operaciones']} ({e['ganadoras']} ✅ / {e['perdedoras']} 🛑)\n"
        f"Winrate: {e['winrate_pct']}%\n"
        f"Resultado: {e['ganancia_total']:+,.2f} {moneda}\n"
        f"{crecimiento}"
        f"Profit factor: {pf}\n"
        f"Ganancia prom.: {e['ganancia_promedio']:,.2f} · Pérdida prom.: {e['perdida_promedio']:,.2f} (ratio {ratio})\n"
        f"Expectativa por operación: {e['expectativa']:+,.2f}\n"
        f"Mejor: {e['mejor_operacion']:,.2f} · Peor: {e['peor_operacion']:,.2f}\n"
        f"Drawdown máx.: {e['max_drawdown']:,.2f}\n"
        f"Racha actual: {racha_txt}\n"
        f"Rachas máx.: {e['racha_max_ganadora']} ganadoras / {e['racha_max_perdedora']} perdedoras"
    )
    _tg(token, "sendMessage", {"chat_id": chat_id, "text": texto, "parse_mode": "HTML"})


def _calcular_en_telegram(token, chat_id, texto, config_bot, obtener_info_cuenta):
    from backend.operaciones.riesgo import calculo_completo
    partes = texto.replace(",", ".").split()[1:]
    try:
        nums = [float(x.rstrip("%")) for x in partes]
    except ValueError:
        nums = []
    if len(nums) < 2:
        _tg(token, "sendMessage", {"chat_id": chat_id, "parse_mode": "HTML",
                                   "text": "Formato: <code>/calc entrada sl [tp] [riesgo%] [parcial% distancia]</code>"})
        return
    entrada, sl = nums[0], nums[1]
    tp = nums[2] if len(nums) > 2 else 0.0
    info = obtener_info_cuenta() if obtener_info_cuenta else None
    if not info:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "No pude leer el balance (¿MT5 conectado?)."})
        return
    if len(nums) > 3 and nums[3] > 0:
        modo, valor = "porcentaje", nums[3]
    elif config_bot.get("modo_riesgo") == "monto_fijo":
        modo, valor = "fijo", float(config_bot.get("riesgo_valor") or 0) or 1.0
    else:
        modo, valor = "porcentaje", float(config_bot.get("riesgo_valor") or 0) or 1.0
    parcial_pct = nums[4] if len(nums) > 5 else None
    parcial_dist = nums[5] if len(nums) > 5 else None
    r = calculo_completo(info["balance"], entrada, sl, tp, config_bot.get("simbolo"), modo, valor, parcial_pct, parcial_dist)
    if r is None:
        _tg(token, "sendMessage", {"chat_id": chat_id, "text": "Faltan datos para calcular (revisa entrada y SL)."})
        return
    m = info["moneda"]
    riesgo_txt = f"{valor}%" if modo == "porcentaje" else f"{valor:,.2f} {m}"
    lineas = [
        f"<b>🧮 {config_bot.get('simbolo')}</b> · riesgo {riesgo_txt} · balance {info['balance']:,.2f} {m}",
        f"Lotaje sugerido: <b>{r['lotaje']}</b>",
        f"Pérdida estimada: {r.get('perdida_estimada', r['dinero_riesgo']):,.2f} {m} ({r.get('riesgo_real_pct', '--')}%)",
    ]
    if tp:
        lineas.append(f"Ganancia estimada: {r.get('ganancia_estimada', 0):,.2f} {m} · R:R 1:{r.get('ratio_rr', 0)}")
    if r.get("oportunidades"):
        lineas.append(f"Oportunidades con este riesgo: {r['oportunidades']}")
    if r.get("parcial"):
        p = r["parcial"]
        lineas.append(
            f"Parcial: cierras {p['lote_parcial']} lotes → +{p['ganancia_parcial']:,.2f} {m}; "
            f"quedan {p['lote_restante']} (riesgo {p['perdida_restante']:,.2f}, si TP +{p['ganancia_restante_si_tp']:,.2f})"
        )
    if r.get("advertencia"):
        lineas.append(f"⚠ {r['advertencia']}")
    _tg(token, "sendMessage", {"chat_id": chat_id, "text": "\n".join(lineas), "parse_mode": "HTML"})