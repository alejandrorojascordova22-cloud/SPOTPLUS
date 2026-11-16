"""Backtest visual del analista usando su configuración de análisis actual."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Callable

import numpy as np
import pandas as pd

from backend.estrategia.estrategia import analizar, tfs_de_lentes
from backend.estrategia.riesgo import dimensionar
from backend.operaciones.tiempo import timestamps_epoch_segundos
from backend.senales.estructura import be_dinamico

TF_SEGUNDOS = {
    "M1": 60,
    "M3": 180,
    "M5": 300,
    "M15": 900,
    "M30": 1800,
    "H1": 3600,
    "H2": 7200,
    "H4": 14400,
    "D1": 86400,
    "W1": 604800,
}


def temporalidades_necesarias(config: dict) -> list[str]:
    temporalidades = config["temporalidades"]
    if temporalidades["modo"] == "manual":
        candidatas = temporalidades["seleccion"]
    else:
        candidatas = [
            tf
            for lista in temporalidades["roles"].values()
            for tf in lista
        ]
    candidatas = list(candidatas) + tfs_de_lentes(config)
    return list(dict.fromkeys(str(tf).upper() for tf in candidatas if str(tf).upper() in TF_SEGUNDOS))


def timeframe_replay(temporalidades: list[str], intervalo_minutos: int = 5) -> str:
    """Elige el marco más rápido que no sea menor que el intervalo de escaneo."""
    validas = [tf for tf in temporalidades if tf in TF_SEGUNDOS]
    if not validas:
        raise ValueError("La configuración del analista no tiene temporalidades válidas.")
    minimo = max(1, intervalo_minutos) * 60
    suficientes = [tf for tf in validas if TF_SEGUNDOS[tf] >= minimo]
    return min(suficientes or validas, key=lambda tf: TF_SEGUNDOS[tf])


def _clave_escenario(escenario: dict) -> tuple:
    rango = escenario.get("zona_rango") or (0, 0)
    return (
        escenario.get("direccion"),
        escenario.get("zona"),
        escenario.get("zona_tf"),
        round(float(rango[0]), 2),
        round(float(rango[1]), 2),
    )


def _buscar_cierre(
    posicion: dict, vela: pd.Series, gap_realista: bool = False
) -> tuple[float, str] | None:
    """Revisa si la vela toca SL/TP.

    gap_realista=False (por defecto): el SL y el TP cierran EXACTO en su precio, así la
    pérdida de un SL es siempre el riesgo configurado (200 fijo -> -200).
    gap_realista=True: si la vela abre más allá del SL/TP se cierra al precio de apertura
    (como un gap de mercado); la pérdida puede pasarse del riesgo.
    """
    apertura = float(vela["open"])
    if posicion["tipo"] == "compra":
        if posicion["sl"] and vela["low"] <= posicion["sl"]:
            precio = min(posicion["sl"], apertura) if gap_realista else posicion["sl"]
            return precio, "be" if posicion["be_aplicado"] else "sl"
        if vela["high"] >= posicion["tp"]:
            precio = max(posicion["tp"], apertura) if gap_realista else posicion["tp"]
            return precio, "tp"
    else:
        if posicion["sl"] and vela["high"] >= posicion["sl"]:
            precio = max(posicion["sl"], apertura) if gap_realista else posicion["sl"]
            return precio, "be" if posicion["be_aplicado"] else "sl"
        if vela["low"] <= posicion["tp"]:
            precio = min(posicion["tp"], apertura) if gap_realista else posicion["tp"]
            return precio, "tp"
    return None


def simular_backtest_analista(
    dfs: dict[str, pd.DataFrame],
    config: dict,
    simbolo: str,
    desde: str,
    hasta: str,
    balance_inicial: float,
    valor_por_unidad_lote: float,
    paso_lote: float = 0.01,
    lote_minimo: float = 0.01,
    lote_maximo: float = 100.0,
    intervalo_minutos: int = 5,
    progreso_callback: Callable[[int, int], None] | None = None,
    analizar_fn: Callable = analizar,
) -> dict:
    """Evalúa solo velas cerradas y convierte los escenarios del analista en trades simulados."""
    tfs = temporalidades_necesarias(config)
    tf_base = timeframe_replay(tfs, intervalo_minutos)
    cfg_riesgo = dict(config["riesgo"])
    # El riesgo en % se calcula sobre la cuenta del backtest (no sobre un capital fijo viejo).
    cfg_riesgo["capital_inicial"] = float(balance_inicial)
    gap_realista = bool(cfg_riesgo.get("gap_realista", False))
    preparadas = {}
    cierres = {}
    for tf, df in (dfs or {}).items():
        tf = str(tf).upper()
        if tf not in TF_SEGUNDOS or df is None or df.empty or "time" not in df:
            continue
        ordenado = df.sort_values("time").drop_duplicates(subset="time").reset_index(drop=True)
        preparadas[tf] = ordenado
        cierres[tf] = (
            ordenado["time"] + pd.to_timedelta(TF_SEGUNDOS[tf], unit="s")
        ).to_numpy(dtype="datetime64[ns]")

    if tf_base not in preparadas:
        return {"error": f"No se encontró histórico de {tf_base} para mostrar el replay."}

    velas_base = preparadas[tf_base]
    inicio = pd.Timestamp(datetime.strptime(desde, "%Y-%m-%d"))
    fin = pd.Timestamp(datetime.strptime(hasta, "%Y-%m-%d")) + pd.Timedelta(days=1)
    tiempos_base = velas_base["time"].to_numpy(dtype="datetime64[ns]")
    indice_inicio = int(np.searchsorted(tiempos_base, inicio.to_datetime64(), side="left"))
    indice_fin = int(np.searchsorted(tiempos_base, fin.to_datetime64(), side="left"))
    indice_fin = min(indice_fin, len(velas_base))
    indice_inicio = min(indice_inicio, indice_fin)
    if indice_fin <= indice_inicio:
        return {"error": f"No hay velas de {tf_base} dentro del rango seleccionado."}

    filas = velas_base.iloc[indice_inicio:indice_fin]
    numero_barras = len(filas)
    posiciones = []
    operaciones = []
    curva_equity = []
    balance = float(balance_inicial)
    tiempos_epoch_base = timestamps_epoch_segundos(velas_base["time"])
    escenarios_vistos = set()
    evaluaciones = 0
    senales = 0
    oportunidades = 0
    entradas = 0
    grupo_siguiente = 1
    pasos_estrategia = []
    escenarios_activos = {}
    indices = filas.index.to_list()
    cache_cortes = {}
    if progreso_callback is not None:
        progreso_callback(0, numero_barras)

    for procesado, indice in enumerate(indices, start=1):
        vela = velas_base.iloc[indice]
        instante = pd.Timestamp(vela["time"]) + pd.Timedelta(seconds=TF_SEGUNDOS[tf_base])
        tiempo_vela = tiempos_epoch_base[indice]
        pasos_vela = []

        cierre = instante.to_datetime64()
        velas_analisis = {}
        for tf in tfs:
            df_tf = preparadas.get(tf)
            if df_tf is None:
                continue
            corte = int(np.searchsorted(cierres[tf], cierre, side="right"))
            if corte:
                previo = cache_cortes.get(tf)
                if previo is not None and previo[0] == corte:
                    velas_analisis[tf] = previo[1]
                else:
                    recorte = df_tf.iloc[max(0, corte - 300):corte].reset_index(drop=True)
                    cache_cortes[tf] = (corte, recorte)
                    velas_analisis[tf] = recorte

        abiertas = []
        for posicion in posiciones:
            if posicion.get("be_pendiente_desde") is not None and indice >= posicion["be_pendiente_desde"]:
                posicion["sl"] = posicion["entrada"]
                posicion["be_aplicado"] = True
                posicion["be_pendiente_desde"] = None
            cierre = _buscar_cierre(posicion, vela, gap_realista)
            if cierre is None:
                abiertas.append(posicion)
                continue
            precio_cierre, motivo = cierre
            direccion = 1 if posicion["tipo"] == "compra" else -1
            profit = (
                (precio_cierre - posicion["entrada"])
                * direccion
                * posicion["volumen"]
                * valor_por_unidad_lote
            )
            balance += profit
            operaciones.append({
                "tipo": posicion["tipo"],
                "entrada": round(posicion["entrada"], 5),
                "sl": round(posicion["sl"], 5),
                "tp": round(posicion["tp"], 5),
                "salida": round(precio_cierre, 5),
                "volumen": posicion["volumen"],
                "profit": round(profit, 2),
                "riesgo_objetivo": posicion["riesgo_objetivo"],
                "riesgo_real": posicion["riesgo_real"],
                "hora_apertura": posicion["hora_apertura"],
                "hora_cierre": str(vela["time"]),
                "motivo_cierre": motivo,
                "be_aplicado": posicion["be_aplicado"],
            })
            pasos_vela.append({
                "tipo": "cierre",
                "texto": f"Cierre {motivo.upper()} · {posicion['tipo']} · {profit:+.2f}",
                "entrada": posicion["entrada"],
                "sl": posicion["sl"],
                "tp": posicion["tp"],
            })
        posiciones = abiertas
        for posicion in posiciones:
            if posicion["be_aplicado"] or posicion.get("be_pendiente_desde") is not None:
                continue
            df_entrada = velas_analisis.get(tf_base)
            if df_entrada is None:
                continue
            proteger, _ = be_dinamico(
                velas_por_temporalidad=velas_analisis,
                tipo_posicion=posicion["tipo"],
                precio_apertura=posicion["entrada"],
                precio_actual=float(vela["close"]),
                grupos_temporalidad=config.get("grupos_temporalidad") or None,
            )
            if proteger:
                posicion["be_pendiente_desde"] = indice + 1

        escenarios = analizar_fn(simbolo, velas_analisis, config) if velas_analisis else []
        evaluaciones += 1
        if escenarios:
            senales += 1
            oportunidades += sum(len(e.get("operaciones", [])) for e in escenarios)

        escenarios_nuevos = []
        claves_actuales = set()
        for escenario in escenarios:
            clave = _clave_escenario(escenario)
            escenario_id = json.dumps(clave, ensure_ascii=False, default=str)
            claves_actuales.add(escenario_id)
            anterior = escenarios_activos.get(escenario_id)
            estado = escenario.get("estado", "")
            cambios = []
            if anterior is None:
                cambios.extend((
                    f"Dirección {escenario.get('direccion', '—')}",
                    f"Rompimiento {escenario.get('fuerza_rompimiento', '—')}",
                    f"Zona {escenario.get('zona', '—')} {escenario.get('zona_tf', '')}: {estado}",
                ))
            elif anterior.get("estado") != estado:
                cambios.append(f"Zona {escenario.get('zona', '—')}: {estado}")
            confirmacion = escenario.get("confirmacion")
            if confirmacion and (anterior is None or not anterior.get("confirmacion")):
                cambios.append(f"Confirmación {confirmacion.get('tf', 'micro')}")
            if cambios:
                operaciones_escenario = escenario.get("operaciones") or []
                pasos_vela.append({
                    "tipo": "analisis",
                    "texto": " · ".join(cambios),
                    "escenario_id": escenario_id,
                    "activo": True,
                    "zona": escenario.get("zona"),
                    "zona_tf": escenario.get("zona_tf"),
                    "zona_rango": list(escenario.get("zona_rango") or ()),
                    "entrada": escenario.get("entrada"),
                    "sl": escenario.get("sl"),
                    "tp": operaciones_escenario[0].get("tp") if operaciones_escenario else None,
                    "direccion": escenario.get("direccion"),
                    "estado": estado,
                })
            escenarios_activos[escenario_id] = escenario
            if clave not in escenarios_vistos:
                escenarios_vistos.add(clave)
                escenarios_nuevos.append(escenario)

        for escenario_id in escenarios_activos.keys() - claves_actuales:
            anterior = escenarios_activos.pop(escenario_id)
            pasos_vela.append({
                "tipo": "invalida",
                "texto": f"Zona {anterior.get('zona', '—')} deja de estar activa",
                "escenario_id": escenario_id,
                "activo": False,
                "zona_rango": list(anterior.get("zona_rango") or ()),
                "entrada": anterior.get("entrada"),
                "sl": anterior.get("sl"),
                "tp": (anterior.get("operaciones") or [{}])[0].get("tp"),
            })

        if not posiciones and escenarios_nuevos:
            for escenario in escenarios_nuevos:
                direccion_mercado = escenario.get("direccion")
                tipo = "compra" if direccion_mercado == "alcista" else "venta"
                entrada = float(escenario.get("entrada", 0))
                sl = float(escenario.get("sl", 0))
                ops = escenario.get("operaciones") or []
                if not ops or entrada <= 0 or sl <= 0:
                    continue
                if (entrada - sl) * (1 if tipo == "compra" else -1) <= 0:
                    continue
                lotes = dimensionar(
                    cfg_riesgo,
                    balance,
                    entrada,
                    sl,
                    ops,
                    valor_por_unidad_lote,
                    paso_lote,
                    lote_minimo,
                    lote_maximo,
                )
                grupo = grupo_siguiente
                grupo_siguiente += 1
                escenario_id = json.dumps(_clave_escenario(escenario), ensure_ascii=False, default=str)
                nuevos = []
                for op, tamano in zip(ops, lotes):
                    tp = float(op.get("tp", 0))
                    volumen = float(tamano.get("lote", 0))
                    if volumen <= 0 or (tp - entrada) * (1 if tipo == "compra" else -1) <= 0:
                        continue
                    nuevos.append({
                        "grupo": grupo,
                        "escenario_id": escenario_id,
                        "nombre_operacion": op.get("nombre", ""),
                        "tipo": tipo,
                        "entrada": entrada,
                        "sl": sl,
                        "tp": tp,
                        "volumen": volumen,
                        "riesgo_objetivo": float(tamano.get("riesgo_objetivo", 0)),
                        "riesgo_real": float(tamano.get("riesgo", 0)),
                        "hora_apertura": str(instante),
                        "be_aplicado": False,
                        "be_pendiente_desde": None,
                    })
                if nuevos:
                    posiciones.extend(nuevos)
                    entradas += len(nuevos)
                    pasos_vela.append({
                        "tipo": "entrada",
                        "texto": f"Entrada {tipo.upper()} · {nuevos[0]['volumen']} lotes",
                        "escenario_id": escenario_id,
                        "activo": True,
                        "zona": escenario.get("zona"),
                        "zona_tf": escenario.get("zona_tf"),
                        "zona_rango": list(escenario.get("zona_rango") or ()),
                        "entrada": entrada,
                        "sl": sl,
                        "tp": nuevos[0]["tp"],
                        "direccion": escenario.get("direccion"),
                        "estado": escenario.get("estado"),
                    })
                    break

        pasos_estrategia.extend({"time": tiempo_vela, **paso} for paso in pasos_vela)
        curva_equity.append({"tiempo": str(vela["time"]), "balance": round(balance, 2)})
        if progreso_callback is not None and (procesado % 100 == 0 or procesado == numero_barras):
            progreso_callback(procesado, numero_barras)

    flotante = 0.0
    posiciones_abiertas = []
    for posicion in posiciones:
        ultimo_precio = float(filas.iloc[-1]["close"])
        direccion = 1 if posicion["tipo"] == "compra" else -1
        profit_flotante = (
            (ultimo_precio - posicion["entrada"])
            * direccion
            * posicion["volumen"]
            * valor_por_unidad_lote
        )
        flotante += profit_flotante
        posiciones_abiertas.append({
            "tipo": posicion["tipo"],
            "entrada": round(posicion["entrada"], 5),
            "sl": round(posicion["sl"], 5),
            "tp": round(posicion["tp"], 5),
            "volumen": posicion["volumen"],
            "profit_flotante": round(profit_flotante, 2),
            "riesgo_objetivo": posicion["riesgo_objetivo"],
            "riesgo_real": posicion["riesgo_real"],
            "riesgo_actual": round(
                abs(posicion["entrada"] - posicion["sl"])
                * posicion["volumen"]
                * valor_por_unidad_lote,
                2,
            ),
            "hora_apertura": posicion["hora_apertura"],
            "be_aplicado": posicion["be_aplicado"],
        })

    ganadoras = [trade for trade in operaciones if trade["profit"] > 0]
    perdedoras = [trade for trade in operaciones if trade["profit"] < 0]
    neutras = [trade for trade in operaciones if trade["profit"] == 0]
    pico = float(balance_inicial)
    max_drawdown = 0.0
    for punto in curva_equity:
        pico = max(pico, punto["balance"])
        max_drawdown = max(max_drawdown, pico - punto["balance"])

    tf_configurados = tfs
    tf_recibidos = [tf for tf in tfs if tf in preparadas]
    tf_faltantes = [tf for tf in tfs if tf not in preparadas]
    tiempos_epoch = tiempos_epoch_base[:indice_fin]
    velas_replay = [
        {
            "time": tiempo,
            "open": round(float(open_), 5),
            "high": round(float(high), 5),
            "low": round(float(low), 5),
            "close": round(float(close), 5),
        }
        for tiempo, open_, high, low, close in zip(
            tiempos_epoch,
            velas_base.iloc[:indice_fin]["open"],
            velas_base.iloc[:indice_fin]["high"],
            velas_base.iloc[:indice_fin]["low"],
            velas_base.iloc[:indice_fin]["close"],
        )
    ]

    return {
        "balance_inicial": float(balance_inicial),
        "balance_final": round(balance, 2),
        "profit_total": round(sum(trade["profit"] for trade in operaciones), 2),
        "profit_flotante_al_final": round(flotante, 2),
        "total_operaciones": len(operaciones),
        "ganadoras": len(ganadoras),
        "perdedoras": len(perdedoras),
        "neutras": len(neutras),
        "tasa_acierto": round(len(ganadoras) / len(operaciones) * 100, 1) if operaciones else 0.0,
        "max_drawdown": round(max_drawdown, 2),
        "valor_por_unidad_lote": float(valor_por_unidad_lote),
        "posicion_abierta_al_final": (
            posiciones_abiertas[0] if posiciones_abiertas else None
        ),
        "posiciones_abiertas": posiciones_abiertas,
        "operaciones": operaciones,
        "pasos_estrategia": pasos_estrategia,
        "curva_equity": curva_equity,
        "velas": velas_replay,
        "indice_inicio_replay": indice_inicio,
        "timeframe_entrada": tf_base,
        "timeframe_macro": None,
        "diagnostico": {
            "estrategia_activa": "Panel Analista",
            "tipo_estrategia": "analista",
            "timeframes_configurados": tf_configurados,
            "timeframes_recibidos": tf_recibidos,
            "timeframes_faltantes": tf_faltantes,
            "evaluaciones_estrategia": evaluaciones,
            "senales_detectadas": senales,
            "oportunidades_detectadas": oportunidades,
            "entradas_ejecutadas": entradas,
            "senales_ignoradas_misma_direccion": 0,
        },
    }