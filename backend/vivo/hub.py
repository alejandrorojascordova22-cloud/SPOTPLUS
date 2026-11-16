"""Hub de ticks en vivo (publicar/suscribir), independiente del bróker.

Idea clave para poder usar MT5 hoy y cTrader mañana: el gráfico NO sabe de
dónde vienen los precios. Cualquier fuente solo llama a ``hub.publicar(...)``:

* MT5 no avisa cuando cambia el precio, así que se le PREGUNTA muy seguido
  (sondeo de ``obtener_tick``) desde UN solo hilo por símbolo, sin importar
  cuántas pantallas haya abiertas. Así se carga poco a MT5 y a su candado.
* cTrader (Open API) sí EMPUJA los ticks: su conector simplemente llamará a
  ``hub.publicar(...)`` cuando le llegue cada evento, sin sondeo.

Cada cliente recibe solo el tick MÁS RECIENTE (si va lento, se descartan los
viejos): en un gráfico en vivo lo único útil es el último precio.
"""
import asyncio
import threading
import time


class HubTicks:
    def __init__(self, obtener_tick=None, intervalo=0.2):
        """``obtener_tick(simbolo) -> {"bid":..,"ask":..} | None`` (solo para
        fuentes por sondeo como MT5). ``None`` si la fuente empuja sola."""
        self._obtener_tick = obtener_tick
        self._intervalo = intervalo
        self._lock = threading.Lock()
        self._clientes = {}      # cola -> (loop, conjunto de símbolos)
        self._ultimo = {}        # simbolo -> último tick publicado
        self._hilos = {}         # simbolo -> Event para detener el sondeo

    # ---- clientes -------------------------------------------------------
    def nueva_cola(self):
        """Crea la cola de un cliente (llamar desde su corrutina)."""
        cola = asyncio.Queue(maxsize=1)
        with self._lock:
            self._clientes[cola] = (asyncio.get_running_loop(), set())
        return cola

    def suscribir(self, cola, simbolo):
        with self._lock:
            if cola not in self._clientes:
                return
            self._clientes[cola][1].add(simbolo)
            ultimo = self._ultimo.get(simbolo)
        if ultimo:
            self._entregar(cola, ultimo)
        self._asegurar_sondeo(simbolo)

    def desuscribir(self, cola, simbolo):
        with self._lock:
            if cola in self._clientes:
                self._clientes[cola][1].discard(simbolo)
        self._limpiar_sondeos()

    def quitar(self, cola):
        with self._lock:
            self._clientes.pop(cola, None)
        self._limpiar_sondeos()

    # ---- publicar (lo llama cualquier fuente) ----------------------------
    def publicar(self, simbolo, bid, ask, t=None):
        tick = {
            "type": "tick",
            "simbolo": simbolo,
            "bid": bid,
            "ask": ask,
            "t": round(t if t is not None else time.time(), 3),
        }
        with self._lock:
            previo = self._ultimo.get(simbolo)
            if previo and previo["bid"] == bid and previo["ask"] == ask:
                return False  # sin cambio: no se manda nada
            self._ultimo[simbolo] = tick
            destinos = [
                (cola, loop) for cola, (loop, simbolos) in self._clientes.items()
                if simbolo in simbolos
            ]
        for cola, loop in destinos:
            try:
                loop.call_soon_threadsafe(self._entregar, cola, tick)
            except RuntimeError:
                pass  # el loop del cliente ya se cerró
        return True

    @staticmethod
    def _entregar(cola, tick):
        if cola.full():
            try:
                cola.get_nowait()  # descarta el viejo: solo importa el último
            except asyncio.QueueEmpty:
                pass
        try:
            cola.put_nowait(tick)
        except asyncio.QueueFull:
            pass

    # ---- sondeo (solo fuentes tipo MT5) ----------------------------------
    def _simbolos_activos(self):
        with self._lock:
            activos = set()
            for _, simbolos in self._clientes.values():
                activos |= simbolos
            return activos

    def _asegurar_sondeo(self, simbolo):
        if self._obtener_tick is None:
            return
        with self._lock:
            if simbolo in self._hilos:
                return
            parar = threading.Event()
            self._hilos[simbolo] = parar
        threading.Thread(
            target=self._bucle_sondeo, args=(simbolo, parar), daemon=True
        ).start()

    def _bucle_sondeo(self, simbolo, parar):
        while not parar.is_set():
            try:
                tick = self._obtener_tick(simbolo)
                if tick:
                    self.publicar(simbolo, tick["bid"], tick["ask"], tick.get("t"))
            except Exception:
                pass  # un fallo puntual de MT5 no debe matar el hilo
            parar.wait(self._intervalo)

    def _limpiar_sondeos(self):
        activos = self._simbolos_activos()
        with self._lock:
            for simbolo in [s for s in self._hilos if s not in activos]:
                self._hilos.pop(simbolo).set()
