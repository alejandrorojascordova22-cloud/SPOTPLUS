"""Rutas de estado persistente del backend y migración desde ubicaciones anteriores."""

import warnings
from pathlib import Path

DIRECTORIO = Path(__file__).resolve().parent


def ruta_archivo(nombre: str, ruta_anterior: str | Path | None = None) -> Path:
    destino = DIRECTORIO / nombre
    anterior = Path(ruta_anterior) if ruta_anterior is not None else None
    destino.parent.mkdir(parents=True, exist_ok=True)

    if anterior is not None and anterior.exists():
        if destino.exists():
            warnings.warn(
                f"Hay datos tanto en {destino} como en {anterior}; "
                "se conservarán ambos y se usará la ruta nueva.",
                RuntimeWarning,
                stacklevel=2,
            )
        else:
            anterior.replace(destino)

    return destino
