"""
ESTRATEGIA (vacía, esperando tus conceptos)
Contrato: analizar(simbolo, velas) -> lista de escenarios (dicts).
velas = {"H4": df, "H1": df, "M15": df}  (df con open, high, low, close, time)
Cada escenario: simbolo, direccion ("alcista"/"bajista"), entrada, sl, tp, rr,
                motivos (lista de texto), contexto (texto), tf, hora_vela
"""
from . import herramientas as t

TF_MACRO = "H4"
TF_MEDIA = "H1"
TF_ENTRADA = "M15"
TEMPORALIDADES = [TF_MACRO, TF_MEDIA, TF_ENTRADA]


def analizar(simbolo, velas):
    return []
