import os
import socket
import subprocess


def _procesos_escuchando_en_puerto(puerto):
    if os.name != "nt":
        return set()

    comando = (
        "$ErrorActionPreference = 'Stop'; "
        f"Get-NetTCPConnection -LocalPort {puerto} -State Listen "
        "-ErrorAction SilentlyContinue | "
        "Select-Object -ExpandProperty OwningProcess -Unique"
    )
    try:
        resultado = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", comando],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(
            f"No se pudo comprobar qué proceso escucha en el puerto {puerto}."
        ) from exc

    if resultado.returncode:
        raise RuntimeError(
            f"No se pudo comprobar qué proceso escucha en el puerto {puerto}: "
            f"{resultado.stderr.strip()}"
        )

    try:
        return {int(linea) for linea in resultado.stdout.splitlines() if linea.strip()}
    except ValueError as exc:
        raise RuntimeError(
            f"Windows devolvió un PID no válido para el puerto {puerto}."
        ) from exc


def comprobar_puerto_disponible(puerto):
    """Fail before startup side effects when the local backend port is occupied."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as servidor:
            servidor.bind(("127.0.0.1", puerto))
    except OSError as exc:
        procesos = _procesos_escuchando_en_puerto(puerto)
        if os.getpid() in procesos and not (procesos - {os.getpid()}):
            return
        raise RuntimeError(
            f"El puerto {puerto} ya está ocupado. Probablemente ya hay un "
            "backend ejecutándose; usa ese servidor o detenlo antes de iniciar otro. "
            f"PID(s) que escuchan: {', '.join(map(str, sorted(procesos))) or 'desconocido'}."
        ) from exc
