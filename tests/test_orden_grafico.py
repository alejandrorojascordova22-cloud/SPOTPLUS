import os

os.environ["API_KEY"] = "test-key"

import pytest
from fastapi import HTTPException

from backend import servidor


def test_orden_desde_grafico_usa_el_simbolo_solicitado(monkeypatch):
    llamadas = []

    def orden_falsa(**kwargs):
        llamadas.append(kwargs)
        return {"ok": True, "ticket": 123, "precio": 1.25}

    monkeypatch.setattr(servidor, "enviar_orden_manual", orden_falsa)
    monkeypatch.setattr(servidor, "_diario_abrir", lambda *args, **kwargs: None)

    resultado = servidor.post_orden_grafico(servidor.OrdenGraficoRequest(
        tipo="compra",
        simbolo="EURUSD",
        volumen=0.01,
    ))

    assert resultado["ok"] is True
    assert llamadas[0]["simbolo"] == "EURUSD"


def test_orden_desde_grafico_rechaza_simbolo_vacio(monkeypatch):
    monkeypatch.setattr(servidor, "enviar_orden_manual", lambda **kwargs: pytest.fail("No debe enviar la orden"))

    with pytest.raises(HTTPException) as error:
        servidor.post_orden_grafico(servidor.OrdenGraficoRequest(
            tipo="compra",
            simbolo=" ",
            volumen=0.01,
        ))

    assert error.value.status_code == 422
