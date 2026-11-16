import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend.operaciones import guardia_riesgo as g


def _deal(tipo=0, entry=0, profit=0.0, comision=0.0, hace=1000, simbolo="XAUUSD", volumen=0.1, comentario="SpotPlus corta"):
    return SimpleNamespace(type=tipo, entry=entry, profit=profit, commission=comision, swap=0.0, fee=0.0,
                           time=int(time.time()) - hace, symbol=simbolo, volume=volumen, comment=comentario)


def _pos(simbolo="XAUUSD", tipo=0, sl=2000.0, tp=2010.0, profit=0.0, ticket=1):
    return SimpleNamespace(symbol=simbolo, type=tipo, sl=sl, tp=tp, profit=profit, swap=0.0, ticket=ticket)


class FakeMt5:
    def __init__(self, balance=10000.0, posiciones=(), pendientes=(), deals=()):
        self.balance = balance
        self.posiciones = list(posiciones)
        self.pendientes = list(pendientes)
        self.deals = list(deals)

    def symbol_info_tick(self, _s):
        return SimpleNamespace(time=int(time.time()))

    def symbol_info(self, _s):
        return SimpleNamespace(point=0.01)

    def positions_get(self, **_k):
        return tuple(self.posiciones)

    def orders_get(self, **_k):
        return tuple(self.pendientes)

    def history_deals_get(self, *_a, **_k):
        return tuple(self.deals)

    def account_info(self):
        return SimpleNamespace(balance=self.balance)

    def last_error(self):
        return (1, "Success")


class GuardiaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.parches = [
            patch.object(g, "RUTA", base / "guardia_riesgo.json"),
            patch.object(g, "RUTA_LOG", base / "guardia.log.jsonl"),
            patch.object(g, "RUTA_TG", base / "telegram_config.json"),
            patch.object(g, "_avisar", lambda texto: None),
        ]
        for p in self.parches:
            p.start()

    def tearDown(self):
        for p in self.parches:
            p.stop()
        self.tmp.cleanup()

    def revisar(self, m, tipo="compra", volumen=0.1, sl=2000.0, tp=2010.0, **k):
        return g.revisar_orden(tipo, volumen, "XAUUSD", sl=sl, tp=tp, mt5_mod=m, **k)

    def test_orden_normal_pasa(self):
        self.assertIsNone(self.revisar(FakeMt5()))

    def test_kill_switch_bloquea_todo_incluso_manuales(self):
        g.parar("prueba")
        r = self.revisar(FakeMt5())
        self.assertEqual(r["bloqueada_por"], "kill_switch")
        r = self.revisar(FakeMt5(), origen="manual")
        self.assertEqual(r["bloqueada_por"], "kill_switch")
        g.reanudar()
        self.assertIsNone(self.revisar(FakeMt5()))

    def test_manuales_saltan_limites_pero_no_el_kill_switch(self):
        m = FakeMt5(posiciones=[_pos(ticket=i, sl=1900 + i) for i in range(6)])
        self.assertEqual(self.revisar(m)["bloqueada_por"], "max_abiertas")
        self.assertIsNone(self.revisar(m, origen="manual"))
        g.poner("aplicar_a_manuales", "true")
        self.assertEqual(self.revisar(m, origen="manual")["bloqueada_por"], "max_abiertas")

    def test_exige_sl_y_lote_maximo(self):
        self.assertEqual(self.revisar(FakeMt5(), sl=0.0)["bloqueada_por"], "sin_sl")
        g.poner("lote_maximo", "0.5")
        self.assertEqual(self.revisar(FakeMt5(), volumen=1.0)["bloqueada_por"], "lote_maximo")
        self.assertIsNone(self.revisar(FakeMt5(), volumen=0.5))

    def test_duplicada_mismo_sl_tp_pero_no_la_pata_con_otro_tp(self):
        m = FakeMt5(posiciones=[_pos(sl=2000.0, tp=2010.0)])
        self.assertEqual(self.revisar(m, sl=2000.0, tp=2010.0)["bloqueada_por"], "duplicada")
        self.assertIsNone(self.revisar(m, sl=2000.0, tp=2030.0))       # otra pata (correr)
        self.assertIsNone(self.revisar(m, tipo="venta", sl=2020.0, tp=1990.0))

    def test_duplicada_en_ventana_de_segundos(self):
        m = FakeMt5(deals=[_deal(entry=0, hace=5)])
        r = self.revisar(m, comentario="SpotPlus corta")
        self.assertEqual(r["bloqueada_por"], "duplicada")
        m = FakeMt5(deals=[_deal(entry=0, hace=300)])
        self.assertIsNone(self.revisar(m, comentario="SpotPlus corta"))

    def test_maximo_de_entradas_por_dia(self):
        g.poner("max_operaciones_por_dia", "3")
        deals = [_deal(entry=0, hace=600 + i, volumen=0.1 + i) for i in range(3)]
        self.assertEqual(self.revisar(FakeMt5(deals=deals))["bloqueada_por"], "max_por_dia")

    def test_perdida_diaria_bloquea_y_se_mantiene_el_resto_del_dia(self):
        # balance actual 9650 tras perder 350 hoy (inicio 10000): 3.5% > 3%
        deals = [_deal(entry=1, profit=-350.0, hace=7200)]
        r = self.revisar(FakeMt5(balance=9650.0, deals=deals))
        self.assertEqual(r["bloqueada_por"], "perdida_diaria")
        # aunque luego "se recupere", sigue bloqueado todo el dia
        recuperado = FakeMt5(balance=10000.0, deals=[_deal(entry=1, profit=0.0, hace=7200)])
        self.assertEqual(self.revisar(recuperado)["bloqueada_por"], "perdida_diaria")
        g.reanudar(incluir_dia=True)
        self.assertIsNone(self.revisar(recuperado))

    def test_perdida_diaria_cuenta_flotante_y_ignora_depositos(self):
        # depositaron 5000 hoy: balance 15000, inicio real 10000, flotante -400 (4%)
        deals = [_deal(tipo=2, entry=0, profit=5000.0, hace=3600)]
        m = FakeMt5(balance=15000.0, posiciones=[_pos(profit=-400.0, sl=1, tp=2)], deals=deals)
        self.assertEqual(self.revisar(m)["bloqueada_por"], "perdida_diaria")
        g.reanudar(incluir_dia=True)
        # sin el flotante no se pasa del limite
        self.assertIsNone(self.revisar(FakeMt5(balance=15000.0, deals=deals)))

    def test_perdida_diaria_por_monto_fijo(self):
        g.poner("perdida_diaria_max_pct", "0")
        g.poner("perdida_diaria_max_monto", "100")
        m = FakeMt5(balance=9890.0, deals=[_deal(entry=1, profit=-110.0, hace=3600)])
        self.assertEqual(self.revisar(m)["bloqueada_por"], "perdida_diaria")

    def test_archivo_corrupto_bloquea(self):
        g.RUTA.write_text("{no es json", encoding="utf-8")
        self.assertEqual(self.revisar(FakeMt5())["bloqueada_por"], "config_ilegible")

    def test_si_mt5_falla_bloquea_en_vez_de_dejar_pasar(self):
        m = FakeMt5()
        m.positions_get = lambda **_k: None
        m.last_error = lambda: (-10004, "No IPC connection")
        self.assertEqual(self.revisar(m)["bloqueada_por"], "error_guardia")

    def test_guardia_desactivada_deja_pasar_pero_kill_switch_no(self):
        g.poner("activo", "false")
        m = FakeMt5(posiciones=[_pos(ticket=i, sl=1900 + i) for i in range(9)])
        self.assertIsNone(self.revisar(m))
        g.parar("x")
        self.assertEqual(self.revisar(m)["bloqueada_por"], "kill_switch")

    def test_el_bloqueo_queda_en_el_log(self):
        g.parar("auditoria")
        self.revisar(FakeMt5())
        lineas = [json.loads(x) for x in g.RUTA_LOG.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(x["evento"] == "bloqueo" and x["codigo"] == "kill_switch" for x in lineas))


class IntegracionConexionTests(unittest.TestCase):
    def test_enviar_orden_manual_no_llega_a_order_send_si_la_guardia_bloquea(self):
        from backend.conexion import conexion_mt5
        bloqueo = {"ok": False, "error": "KILL SWITCH", "bloqueada_por": "kill_switch", "guardia": True}
        with patch.object(g, "revisar_orden", return_value=bloqueo) as rev, \
                patch.object(conexion_mt5.mt5, "order_send") as enviar:
            r = conexion_mt5.enviar_orden_manual("compra", 0.01, simbolo="XAUUSD", sl=1.0, tp=2.0)
        self.assertEqual(r, bloqueo)
        enviar.assert_not_called()
        self.assertEqual(rev.call_args.kwargs["origen"], "bot")


if __name__ == "__main__":
    unittest.main()
