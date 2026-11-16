// Gráfico en vivo: velas históricas de MT5 + la vela actual moviéndose con cada tick.
// El navegador/WebView abre el WebSocket /ws/vivo del servidor y actualiza la última
// vela al instante. No sabe de qué bróker viene el precio (hoy MT5, mañana cTrader).
//
// Estilo tipo TradingView / FX Replay / Memorando:
//  - barra de herramientas completa (líneas, rayos, zona, elipse, Fibonacci, posiciones
//    larga/corta, medir, texto, pincel, borrador) y pantalla completa
//  - cada operación del diario se dibuja como caja verde/roja (cerradas y en curso),
//    con flechas de entrada/salida y la línea punteada entrada → salida
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { z } from 'zod';

const TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const;
const TF_SEG: Record<string, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
const CANTIDAD_VELAS = 800;
const REFRESCO_OPS_MS = 15000;
const REFRESCO_BOT_MS = 5000;   // lo que el bot detecta cambia por vela cerrada: 5 s sobra
const normalizarSimbolo = (valor: string | null | undefined) => (valor ?? '').trim().replace(/[\s_-]+/g, '').toUpperCase();
const precioValido = (valor: number | null | undefined): number | null => (typeof valor === 'number' && Number.isFinite(valor) && valor > 0 ? valor : null);

const VelaSchema = z.object({ time: z.number(), open: z.number(), high: z.number(), low: z.number(), close: z.number() });
const VelasRespSchema = z.union([
  z.object({ timeframe: z.string(), velas: z.array(VelaSchema) }),
  z.object({ error: z.string() }),
]);
const LentesVivoSchema = z.object({
  lentes: z.array(z.object({
    nombre: z.string(),
    vista: z.string(),
    estructura: z.string(),
    direccion: z.string(),
    direccion_vista: z.string(),
    fase: z.string(),
    pivotes: z.array(z.object({
      time: z.number(), precio: z.number(), tipo: z.enum(['high', 'low']), clase: z.string(),
    })),
    quiebres: z.array(z.object({
      time: z.number(), precio: z.number(), direccion: z.string(), tipo: z.enum(['BOS', 'CHOCH']),
    })),
  })),
  zonas: z.array(z.object({
    estructura: z.string(), tipo: z.string(), direccion: z.string(), estado: z.string(),
    rango: z.tuple([z.number(), z.number()]),
  })),
  temporalidades_faltantes: z.array(z.string()),
});
const FichaSchema = z.object({
  id: z.number().optional(),
  simbolo: z.string(),
  tipo: z.string(),
  estado: z.string(),
  volumen: z.number().nullable().optional(),
  entrada: z.number().nullable().optional(),
  sl: z.number().nullable().optional(),
  tp: z.number().nullable().optional(),
  hora_apertura: z.number().nullable().optional(),
  hora_cierre: z.number().nullable().optional(),
  precio_cierre: z.number().nullable().optional(),
  profit: z.number().nullable().optional(),
  resultado: z.string().nullable().optional(),
});
const PosicionAbiertaSchema = z.object({
  ticket: z.number().nullable().optional(),
  simbolo: z.string(),
  tipo: z.string(),
  volumen: z.number().nullable().optional(),
  precio_apertura: z.number().nullable().optional(),
  precio_actual: z.number().nullable().optional(),
  profit: z.number().nullable().optional(),
  sl: z.number().nullable().optional(),
  tp: z.number().nullable().optional(),
  hora_apertura: z.number().nullable().optional(),
  comment: z.string().nullable().optional(),
});
const OrdenManualRespSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  ticket: z.union([z.number(), z.string()]).optional(),
  precio: z.number().optional(),
}).passthrough();

type EstadoVivo = 'conectando' | 'vivo' | 'sin_ticks' | 'reconectando' | 'auth';
const ETIQUETA: Record<EstadoVivo, { texto: string; color: string }> = {
  conectando: { texto: 'Conectando…', color: '#8893a0' },
  vivo: { texto: 'EN VIVO', color: '#22c55e' },
  sin_ticks: { texto: 'Sin ticks (¿mercado cerrado?)', color: '#e4b75a' },
  reconectando: { texto: 'Reconectando…', color: '#f97316' },
  auth: { texto: 'Clave API rechazada', color: '#ef4444' },
};

type Op = {
  id: number; lado: 'compra' | 'venta'; estado: string; tA: number; tC: number | null;
  entrada: number; sl: number | null; tp: number | null; cierre: number | null;
  profit: number | null; res: string; vol: number | null;
};

function construirHtmlVivo(wsUrl: string, apiKey: string, replay = false): string {
  const seguro = (v: string) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0a1118; overflow: hidden; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
  /* Barra de herramientas acoplada a la izquierda (ya no flota sobre las velas) */
  #barra { position: absolute; left: 0; top: 0; bottom: 0; width: 46px; z-index: 5; display: flex; flex-direction: column; align-items: center; gap: 1px;
           background: #0a1118; border-right: 1px solid #1e222d; padding: 4px 0; box-sizing: border-box;
           overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
  #barra::-webkit-scrollbar { display: none; }
  #barra button { width: 36px; height: 28px; flex: none; border: 0; border-radius: 6px; background: transparent; color: #9aa0ad;
                  cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
  #barra button svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  #barra button:hover { background: #1e222d; color: #fff; }
  #barra button.on { background: #2962ff; color: #fff; }
  #barra hr { width: 24px; border: 0; border-top: 1px solid #1e222d; margin: 3px 0; flex: none; }
  #barra .abajo { margin-top: auto; }
  #area { position: absolute; left: 46px; top: 0; right: 0; bottom: 28px; }
  #chart { position: absolute; inset: 0; background: #0a1118; }
  #ov { position: absolute; inset: 0; z-index: 3; pointer-events: none; touch-action: none; }
  /* Leyenda superior: símbolo, OHLC y precios Vender / Comprar */
  #leyenda { position: absolute; left: 12px; top: 8px; z-index: 4; pointer-events: none; color: #d1d4dc; font-size: 13px; line-height: 20px; }
  #lg-tit { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; text-shadow: 0 0 4px #0a1118, 0 0 4px #0a1118; }
  #lg-sim { font-weight: 700; font-size: 14px; color: #e8ebf2; }
  #lg-live { display: inline-flex; align-items: center; gap: 5px; color: #26a69a; font-weight: 600; }
  #lg-live i { width: 7px; height: 7px; border-radius: 50%; background: #26a69a; display: inline-block; }
  #lg-live.off { color: #8893a0; } #lg-live.off i { background: #8893a0; }
  #lg-ohlc b { font-weight: 500; color: #8893a0; margin-left: 6px; } #lg-ohlc b:first-child { margin-left: 0; }
  #lg-px { display: flex; align-items: stretch; margin-top: 6px; }
  #lg-px .caja { min-width: 74px; padding: 3px 9px; border-radius: 4px; text-align: center; font-weight: 700; font-size: 15px; line-height: 17px; background: rgba(11,14,19,0.85); cursor: pointer; font-family: inherit; }
  #lg-px .caja small { display: block; font-size: 10px; font-weight: 700; letter-spacing: 0.4px; line-height: 12px; }
  #px-v { color: #ef5350; border: 1px solid #ef5350; border-radius: 4px 0 0 4px !important; pointer-events: auto; }
  #px-c { color: #2962ff; border: 1px solid #2962ff; border-radius: 0 4px 4px 0 !important; pointer-events: auto; }
  #px-v:hover { background: rgba(239,83,80,0.18); } #px-c:hover { background: rgba(41,98,255,0.18); }
  #px-sp { align-self: center; padding: 0 8px; color: #8893a0; font-size: 12px; background: #0a1118; }
  /* Cuenta regresiva de la vela, pegada bajo la etiqueta del último precio */
  #cd { position: absolute; z-index: 4; display: none; pointer-events: none; background: #ef5350; color: #fff; font-weight: 600; font-size: 12px;
        text-align: center; line-height: 18px; height: 18px; border-radius: 0 0 3px 3px; font-variant-numeric: tabular-nums; }

  /* Barra inferior: fecha/hora, cierre de la vela y zona horaria */
  #estado { position: absolute; left: 46px; right: 0; bottom: 0; height: 28px; z-index: 4; display: flex; align-items: center; justify-content: flex-end; gap: 12px;
            padding: 0 12px; background: #0a1118; border-top: 1px solid #1e222d; color: #b2b5be; font-size: 12px; font-variant-numeric: tabular-nums; box-sizing: border-box; }
  #estado select { background: #131722; color: #d1d4dc; border: 1px solid #2a2e39; border-radius: 4px; font-size: 12px; padding: 2px 4px; max-width: 150px; }
  #reloj b { color: #d1d4dc; font-weight: 600; }
  /* Botón y menú "Operaciones" */
  #opsbtn { position: absolute; top: 8px; right: 84px; z-index: 6; height: 30px; padding: 0 10px; display: flex; align-items: center; gap: 7px; cursor: pointer;
            background: #131722; border: 1px solid #2a2e39; border-radius: 6px; color: #d1d4dc; font-size: 13px; font-weight: 600; }
  #opsbtn:hover { background: #1e222d; }
  #opsbtn svg, #chip svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  #opsmenu { position: absolute; top: 44px; right: 84px; z-index: 7; width: 270px; display: none; padding: 6px 0 10px; background: #131722; border: 1px solid #2a2e39;
             border-radius: 8px; color: #d1d4dc; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  #opsmenu .fila { display: flex; justify-content: space-between; align-items: center; padding: 7px 14px; cursor: pointer; }
  #opsmenu .fila:hover { background: #1e222d; }
  #opsmenu input[type=checkbox] { width: 16px; height: 16px; accent-color: #2962ff; cursor: pointer; }
  #opsmenu .tit { padding: 8px 14px 4px; color: #8893a0; font-size: 11px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; }
  #opsmenu .seg { display: flex; gap: 4px; padding: 2px 14px; }
  #opsmenu .seg button { flex: 1; height: 28px; background: #0a1118; color: #b2b5be; border: 1px solid #2a2e39; border-radius: 5px; font-size: 12px; cursor: pointer; padding: 0 4px; }
  #opsmenu .seg button.on { background: #2962ff; border-color: #2962ff; color: #fff; }
  #chartmore { position: absolute; top: 8px; right: 12px; z-index: 6; width: 34px; height: 30px; border: 1px solid #2a2e39; border-radius: 6px; background: #131722; color: #d1d4dc; font-size: 20px; cursor: pointer; }
  #chartmenu { position: absolute; top: 44px; right: 12px; z-index: 8; width: 240px; display: none; padding: 5px 0; background: #131722; border: 1px solid #2a2e39; border-radius: 8px; color: #d1d4dc; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  #chartmenu button { width: 100%; padding: 9px 12px; border: 0; background: transparent; color: inherit; text-align: left; font-size: 13px; cursor: pointer; }
  #chartmenu button:hover { background: #1e222d; }
  #chartmenu .nota { padding: 5px 12px 8px; color: #8893a0; font-size: 11px; }
  #panel-fondo { position: absolute; inset: 0; z-index: 12; display: none; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,0.55); box-sizing: border-box; }
  #panel-grafico { width: min(360px, 100%); max-height: 90%; overflow: auto; padding: 16px; background: #131722; border: 1px solid #2a2e39; border-radius: 10px; color: #d1d4dc; box-shadow: 0 12px 32px rgba(0,0,0,0.55); }
  #panel-grafico h3 { margin: 0 0 8px; font-size: 16px; }
  #panel-grafico p { margin: 0 0 12px; color: #8893a0; font-size: 12px; line-height: 1.4; }
  #panel-grafico label.fila { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid #252a35; font-size: 13px; }
  #panel-grafico input[type=checkbox] { width: 16px; height: 16px; accent-color: #2962ff; }
  #panel-grafico input[type=number] { width: 100%; box-sizing: border-box; margin: 6px 0 10px; padding: 9px; border: 1px solid #2a2e39; border-radius: 6px; background: #0a1118; color: #d1d4dc; font-size: 15px; }
  #panel-grafico .acciones { display: flex; gap: 8px; margin-top: 12px; }
  #panel-grafico .acciones button, #panel-grafico .direccion button { flex: 1; padding: 9px; border: 1px solid #2a2e39; border-radius: 6px; background: #0a1118; color: #d1d4dc; font-size: 13px; cursor: pointer; }
  #panel-grafico button.primario { background: #2962ff; border-color: #2962ff; color: #fff; }
  #panel-grafico .direccion { display: flex; gap: 8px; }
  #panel-grafico .direccion button.on { border-color: #2962ff; background: #1b2b53; color: #fff; }
  #panel-grafico input[type=color] { width: 32px; height: 28px; padding: 2px; border: 1px solid #2a2e39; border-radius: 5px; background: #0a1118; cursor: pointer; }
  #lentes-lista .lente-item { display: grid; grid-template-columns: 16px 10px minmax(0,1fr) 32px 54px; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid #252a35; font-size: 12px; }
  #lentes-lista .lente-item input[type=checkbox] { width: 16px; height: 16px; margin: 0; accent-color: #2962ff; }
  #lentes-lista .lente-color { width: 10px; height: 10px; border-radius: 50%; }
  #lentes-lista .lente-texto { min-width: 0; line-height: 1.4; overflow-wrap: anywhere; }
  #lentes-lista button { padding: 5px 6px; border: 1px solid #394552; border-radius: 5px; background: #0a1118; color: #d1d4dc; font-size: 11px; cursor: pointer; }
  #lentes-lista button:hover { border-color: #ef5350; color: #ff9a9a; }
  #alertas-lista { margin-top: 8px; }
  #alertas-lista .alerta-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 1px solid #252a35; font-size: 12px; }
  #alertas-lista button { border: 0; background: transparent; color: #ef5350; cursor: pointer; }
  #alerta-toast { position: absolute; left: 50%; bottom: 40px; z-index: 13; display: none; transform: translateX(-50%); max-width: 90%; padding: 10px 14px; border: 1px solid #22c55e; border-radius: 8px; background: #131722; color: #fff; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,0.5); }
  /* Etiqueta "#8 Mostrar / Ocultar" al pasar el mouse sobre una operación */
  #chip { position: absolute; z-index: 6; display: none; align-items: center; gap: 8px; height: 30px; padding: 0 12px; background: #131722; border: 1px solid #2a2e39;
          border-radius: 8px; color: #d1d4dc; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.5); }
  #chip b { color: #8893a0; font-weight: 600; } #chip:hover { background: #1e222d; }
  /* Barra flotante de herramientas (arrastrable) */
  #flot { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 5; display: none; align-items: center; gap: 2px; padding: 4px 6px 4px 2px;
          background: rgba(19,23,34,0.94); border: 1px solid #2a2e39; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.45); }
  #flot button { width: 32px; height: 30px; flex: none; border: 0; border-radius: 6px; background: transparent; color: #b2b5be; cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; }
  #flot button svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  #flot button:hover { background: #1e222d; color: #fff; } #flot button.on { background: #2962ff; color: #fff; }
  #flot .grip { width: 18px; height: 30px; display: flex; align-items: center; justify-content: center; color: #596572; cursor: grab; touch-action: none; }
  #flot .grip svg { width: 12px; height: 18px; }
</style></head>
<body>
<div id="barra">
  <button data-h="cursor" class="on" title="Cursor"></button>
  <hr />
  <button data-h="t" title="Línea de tendencia"></button>
  <button data-h="ray" title="Rayo"></button>
  <button data-h="ext" title="Línea extendida"></button>
  <button data-h="h" title="Línea horizontal"></button>
  <button data-h="r" title="Rayo horizontal"></button>
  <button data-h="v" title="Línea vertical"></button>
  <button data-h="arrow" title="Flecha"></button>
  <hr />
  <button data-h="z" title="Zona (rectángulo)"></button>
  <button data-h="e" title="Elipse"></button>
  <button data-h="f" title="Retroceso Fibonacci"></button>
  <hr />
  <button data-h="long" title="Posición larga (compra)"></button>
  <button data-h="short" title="Posición corta (venta)"></button>
  <button data-h="m" title="Medir"></button>
  <hr />
  <button data-h="tx" title="Texto"></button>
  <button data-h="p" title="Pincel"></button>
  <button data-h="x" title="Borrar un dibujo (clic sobre él)"></button>
  <hr class="abajo" />
  <button id="b-flot" title="Barra flotante de herramientas"></button>
  <button id="b-undo" title="Deshacer último dibujo"></button>
  <button id="b-ver" title="Mostrar / ocultar dibujos"></button>
  <button id="b-ops" title="Mostrar / ocultar operaciones"></button>
  <button id="b-clear" title="Borrar todos los dibujos"></button>
</div>
<div id="area">
  <div id="chart"></div>
  <canvas id="ov"></canvas>
  <div id="leyenda">
    <div id="lg-tit"><span id="lg-sim"></span><span id="lg-live" class="off"><i></i><span id="lg-live-t">Conectando</span></span><span id="lg-ohlc"></span></div>
    <div id="lg-px"><button type="button" class="caja" id="px-v" title="Abrir ticket de venta"><span id="px-vv">—</span><small>VENDER</small></button><div id="px-sp"></div><button type="button" class="caja" id="px-c" title="Abrir ticket de compra"><span id="px-cv">—</span><small>COMPRAR</small></button></div>
  </div>
  <div id="cd"></div>
  <div id="flot">
    <span class="grip" id="grip" title="Arrastrar"></span>
    <button data-h="t" title="Línea de tendencia"></button>
    <button data-h="h" title="Línea horizontal"></button>
    <button data-h="z" title="Zona (rectángulo)"></button>
    <button data-h="f" title="Retroceso Fibonacci"></button>
    <button data-h="long" title="Posición larga (compra)"></button>
    <button data-h="short" title="Posición corta (venta)"></button>
    <button data-h="tx" title="Texto"></button>
    <button data-h="x" title="Borrar un dibujo"></button>
  </div>
  <button id="opsbtn" title="Operaciones"><svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg><span>Operaciones</span></button>
  <div id="opsmenu">
    <label class="fila"><span>Mostrar operaciones</span><input type="checkbox" data-c="verOps"></label>
    <label class="fila"><span>Flechas de entrada / salida</span><input type="checkbox" data-c="flechas"></label>
    <label class="fila"><span>L\u00ednea entrada \u2192 salida</span><input type="checkbox" data-c="linea"></label>
    <label class="fila"><span>Etiqueta con resultado</span><input type="checkbox" data-c="etiqueta"></label>
    <label class="fila"><span>L\u00edneas SL / TP en curso</span><input type="checkbox" data-c="niveles"></label>
    <label class="fila"><span>Barra flotante de herramientas</span><input type="checkbox" data-c="flot"></label>
    <div class="tit">Cajas SL / TP</div>
    <div class="seg" data-s="cajas"><button data-v="siempre">Siempre</button><button data-v="clic">Al pulsar</button><button data-v="nunca">Nunca</button></div>
    <div class="tit">Qu\u00e9 operaciones</div>
    <div class="seg" data-s="alcance"><button data-v="todas">Todas</button><button data-v="curso">Solo en curso</button></div>
  </div>
  <button id="chartmore" title="Opciones del gráfico">⋯</button>
  <div id="chartmenu">
    <button data-chart="reset">Restablecer visualización del gráfico</button>
    <button data-chart="alerta">Añadir alerta al precio señalado</button>
    <button data-chart="alerta-actual">Añadir alerta al precio actual</button>
    <button data-chart="config">Opciones de configuración</button>
    <div class="nota">Las alertas funcionan mientras el gráfico está abierto.</div>
  </div>
  <div id="panel-fondo">
    <div id="panel-grafico">
      <section id="panel-alerta" style="display:none">
        <h3 id="alerta-titulo">Nueva alerta de precio</h3>
        <p>Alerta local de este gráfico; no envía órdenes ni notificaciones fuera de la aplicación.</p>
        <label for="alerta-precio">Precio</label>
        <input id="alerta-precio" type="number" step="any" />
        <p id="alerta-error" style="color:#ef5350"></p>
        <div class="direccion">
          <button data-direccion="arriba" class="on">Cruzar hacia arriba</button>
          <button data-direccion="abajo">Cruzar hacia abajo</button>
        </div>
        <div class="acciones">
          <button id="alerta-cancelar">Cancelar</button>
          <button id="alerta-guardar" class="primario">Crear alerta</button>
        </div>
      </section>
      <section id="panel-config" style="display:none">
        <h3>Configuración del gráfico</h3>
        <label class="fila"><span>Mostrar cuadrícula</span><input id="cfg-cuadricula" type="checkbox" /></label>
        <label class="fila"><span>Escala de precio automática</span><input id="cfg-autoescala" type="checkbox" /></label>
        <label class="fila"><span>Línea del último precio</span><input id="cfg-linea-precio" type="checkbox" /></label>
        <p>ESTRUCTURA POR LENTE · vista / estructura. Cambios solo para este gráfico; “Quitar” oculta y puedes volver a activar el lente.</p>
        <div id="lentes-lista"></div>
        <p id="lentes-info"></p>
        <p>Alertas de precio guardadas en este navegador</p>
        <div id="alertas-lista"></div>
        <div class="acciones">
          <button id="config-cerrar" class="primario">Cerrar</button>
        </div>
      </section>
    </div>
  </div>
  <div id="alerta-toast"></div>
  <div id="chip"></div>
</div>
<div id="estado"><span id="reloj"></span><select id="tz" title="Zona horaria"></select></div>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<script>
(function () {
  var WS_URL = ${seguro(wsUrl)};
  var KEY = ${seguro(apiKey)};
  var REPLAY = ${replay ? 'true' : 'false'};
  var PFX = REPLAY ? 'replay_' : '';   // el replay guarda sus ajustes y dibujos aparte del gráfico en vivo

  // Colores (estilo Memorando / TradingView oscuro)
  var C_SUBE = '#2962ff', C_BAJA = '#e8ebf2';
  var VERDE = 'rgba(38,166,154,0.38)', VERDE_L = 'rgba(38,166,154,0.95)';
  var ROJO = 'rgba(239,83,80,0.38)', ROJO_L = 'rgba(239,83,80,0.95)';
  var RR = 2;   // relación riesgo/beneficio de las herramientas Larga / Corta
  // Si las flechas salen corridas de hora, pon aquí el desfase fijo del bróker en segundos
  // (ej. 7200 = UTC+2). null = se calcula solo con el primer tick.
  var OFFSET_FIJO = null;

  function enviar(o) {
    try {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(o));
      else window.parent.postMessage(o, '*');
    } catch (e) {}
  }

  var cont = document.getElementById('chart');
  var chart = LightweightCharts.createChart(cont, {
    layout: { background: { color: '#0a1118' }, textColor: '#a5b2bc', fontSize: 12, fontFamily: '-apple-system, Segoe UI, Roboto, sans-serif' },
    grid: { vertLines: { color: 'rgba(42,46,57,0.18)' }, horzLines: { color: 'rgba(42,46,57,0.18)' } },
    crosshair: {
      mode: 0,
      vertLine: { color: '#26a69a', style: 2, width: 1, labelBackgroundColor: '#2a2e39' },
      horzLine: { color: '#26a69a', style: 2, width: 1, labelBackgroundColor: '#2a2e39' },
    },
    rightPriceScale: { borderColor: '#1e222d', scaleMargins: { top: 0.14, bottom: 0.1 }, minimumWidth: 74 },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#1e222d', rightOffset: 10, barSpacing: 9, minBarSpacing: 1 },
    width: cont.clientWidth,
    height: cont.clientHeight,
  });
  var serie = chart.addCandlestickSeries({
    upColor: C_SUBE, downColor: C_BAJA, borderVisible: false,
    wickUpColor: C_SUBE, wickDownColor: C_BAJA,
    priceLineStyle: 3, priceLineColor: 'rgba(209,212,220,0.55)', priceLineWidth: 1,
  });

  var ov = document.getElementById('ov');
  var ctx = ov.getContext('2d');
  function ajustarTamano() {
    var w = cont.clientWidth, h = cont.clientHeight, r = window.devicePixelRatio || 1;
    chart.applyOptions({ width: w, height: h });
    ov.width = Math.round(w * r); ov.height = Math.round(h * r);
    ov.style.width = w + 'px'; ov.style.height = h + 'px';
    ctx.setTransform(r, 0, 0, r, 0, 0);
  }
  window.addEventListener('resize', ajustarTamano);
  ajustarTamano();

  function normalizarSimboloWeb(v) {
    return String(v || '').trim().replace(/[\s_-]+/g, '').toUpperCase();
  }
  var simbolo = null;      // símbolo mostrado
  var suscrito = null;     // símbolo al que el servidor nos tiene suscritos
  var tfSeg = 60;
  var datos = [];          // velas cargadas (para convertir tiempo <-> posición)
  var ultima = null;       // vela en formación
  var ws = null, abierto = false, huboConexion = false, sinAuth = false;
  var espera = 1000, timerReconexion = null;
  var ultimoTickMs = 0, bid = null, ask = null;
  var estadoEnviado = '', pxEnviado = '';
  var offsetSeg = OFFSET_FIJO === null ? 0 : OFFSET_FIJO;
  var offsetListo = OFFSET_FIJO !== null;
  var opsRaw = [], lineasNivel = [], opsVisibles = true;
  var botRaw = [], lineasBot = [];   // lo que el bot detecta (zonas, niveles, motivos): solo se dibuja

  function precision(p) { return p > 500 ? 2 : (p > 50 ? 3 : 5); }
  function fmt(p) { return p.toFixed(ultima ? precision(ultima.close) : 2); }

  // ---------- Iconos de la barra (SVG de línea, como TradingView) ----------
  var ICONOS = {
    cursor: '<path d="M12 4v6M12 14v6M4 12h6M14 12h6"/>',
    t: '<path d="M7 17L17 7"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/>',
    ray: '<circle cx="6" cy="18" r="2"/><path d="M8 16L21 3"/>',
    ext: '<path d="M3 21L21 3"/><circle cx="9" cy="15" r="2"/><circle cx="15" cy="9" r="2"/>',
    h: '<path d="M3 12h6M15 12h6"/><circle cx="12" cy="12" r="2"/>',
    r: '<circle cx="5" cy="12" r="2"/><path d="M7 12h14"/>',
    v: '<path d="M12 3v6M12 15v6"/><circle cx="12" cy="12" r="2"/>',
    arrow: '<path d="M5 19L19 5M9 5h10v10"/>',
    z: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    e: '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
    f: '<path d="M4 5h16M4 10h16M4 15h16M4 20h16"/><path d="M7 20L17 5" stroke-dasharray="2 2"/>',
    long: '<rect x="4" y="4" width="16" height="8" fill="#26a69a" fill-opacity=".45" stroke="#26a69a"/><rect x="4" y="12" width="16" height="7" fill="#ef5350" fill-opacity=".45" stroke="#ef5350"/>',
    short: '<rect x="4" y="5" width="16" height="7" fill="#ef5350" fill-opacity=".45" stroke="#ef5350"/><rect x="4" y="12" width="16" height="8" fill="#26a69a" fill-opacity=".45" stroke="#26a69a"/>',
    m: '<path d="M3.5 15.5l12-12 5 5-12 12z"/><path d="M7 12l2 2M10 9l2 2M13 6l2 2"/>',
    tx: '<path d="M6 6h12M12 6v13M9 19h6"/>',
    p: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
    x: '<path d="M8 20h11M5 15l8-9 6 6-6 6H9z"/><path d="M9 11l6 6"/>',
    undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 8h-3"/>',
    ver: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    ops: '<path d="M6 20V10M12 20V4M18 20v-7"/>',
    clear: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    flot: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7.5 12h.01M12 12h.01M16.5 12h.01"/>',
    ojo: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    ojoNo: '<path d="M3 3l18 18M10.6 6.1A9.7 9.7 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.6 7.6A17 17 0 002 12s4 7 10 7a9.6 9.6 0 004.2-1"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/>'
  };
  (function () {
    var bs = document.querySelectorAll('#barra button, #flot button');
    for (var i = 0; i < bs.length; i++) {
      var k = bs[i].getAttribute('data-h') || bs[i].id.replace('b-', '');
      if (ICONOS[k]) bs[i].innerHTML = '<svg viewBox="0 0 24 24">' + ICONOS[k] + '</svg>';
    }
    document.getElementById('grip').innerHTML = '<svg viewBox="0 0 12 18" fill="currentColor" stroke="none"><circle cx="3.5" cy="3" r="1.4"/><circle cx="8.5" cy="3" r="1.4"/><circle cx="3.5" cy="9" r="1.4"/><circle cx="8.5" cy="9" r="1.4"/><circle cx="3.5" cy="15" r="1.4"/><circle cx="8.5" cy="15" r="1.4"/></svg>';
  })();

  // ---------- Leyenda OHLC, Vender/Comprar y cuenta regresiva ----------
  var elSim = document.getElementById('lg-sim'), elOhlc = document.getElementById('lg-ohlc');
  var elLive = document.getElementById('lg-live'), elLiveT = document.getElementById('lg-live-t');
  var elVv = document.getElementById('px-vv'), elCv = document.getElementById('px-cv'), elSp = document.getElementById('px-sp');
  var elPv = document.getElementById('px-v'), elPc = document.getElementById('px-c');
  var elCd = document.getElementById('cd');
  var tfEtiqueta = '', hover = null;
  function idxDeTiempo(t) {
    var lo = 0, hi = datos.length - 1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (datos[mid].time === t) return mid; if (datos[mid].time < t) lo = mid + 1; else hi = mid - 1; }
    return -1;
  }
  function pintarOHLC(c) {
    if (!c || !datos.length) { elOhlc.innerHTML = ''; return; }
    var i = idxDeTiempo(c.time), previo = i > 0 ? datos[i - 1].close : c.open;
    var dif = c.close - previo, pct = previo ? dif / previo * 100 : 0;
    var col = dif >= 0 ? '#26a69a' : '#ef5350';
    var sg = dif >= 0 ? '+' : '\\u2212';
    elOhlc.innerHTML = '<span style="color:' + col + '"><b>O</b>' + fmt(c.open) + '<b>H</b>' + fmt(c.high) + '<b>L</b>' + fmt(c.low) + '<b>C</b>' + fmt(c.close) +
      '<b style="color:' + col + '">' + sg + fmt(Math.abs(dif)) + ' (' + sg + Math.abs(pct).toFixed(2) + '%)</b></span>';
  }
  chart.subscribeCrosshairMove(function (p) {
    var c = p && p.time !== undefined && p.seriesData ? p.seriesData.get(serie) : null;
    hover = c || null;
    pintarOHLC(hover || ultima);
  });
  function pintarPrecios() {
    if (bid === null || ask === null) { elVv.textContent = '\\u2014'; elCv.textContent = '\\u2014'; elSp.textContent = ''; return; }
    elVv.textContent = fmt(bid); elCv.textContent = fmt(ask); elSp.textContent = fmt(ask - bid);
  }
  function solicitarOrden(tipo) {
    if (REPLAY) return;
    if (!simbolo || bid === null || ask === null) { mostrarToast('Espera a que haya una cotización en vivo para abrir el ticket.'); return; }
    enviar({ type: 'orden_solicitada', tipo: tipo, simbolo: simbolo, bid: bid, ask: ask });
  }
  elPv.addEventListener('click', function () { solicitarOrden('venta'); });
  elPc.addEventListener('click', function () { solicitarOrden('compra'); });
  function pintarCuenta() {
    if (!ultima || !offsetListo || !ultimoTickMs) { elCd.style.display = 'none'; return; }
    var y = serie.priceToCoordinate(ultima.close);
    if (y === null || y === undefined) { elCd.style.display = 'none'; return; }
    var resta = Math.max(0, Math.floor(ultima.time + tfSeg - (Date.now() / 1000 + offsetSeg)));
    var hh = Math.floor(resta / 3600), mm = Math.floor((resta % 3600) / 60), ss = resta % 60;
    function d2(n) { return (n < 10 ? '0' : '') + n; }
    elCd.textContent = (hh ? hh + ':' : '') + d2(mm) + ':' + d2(ss);
    var ancho = 74;
    try { ancho = chart.priceScale('right').width(); } catch (e) {}
    elCd.style.width = ancho + 'px';
    elCd.style.left = (cont.clientWidth - ancho) + 'px';
    elCd.style.top = (y + 9) + 'px';
    elCd.style.display = 'block';
  }
  function verRecientes() {
    var n = datos.length; if (!n) return;
    var vis = Math.max(40, Math.min(130, Math.round(cont.clientWidth / 8)));
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - vis), to: n + 8 });
  }

  // ---------- Ajustes del usuario (se recuerdan en este navegador) ----------
  var CFG0 = { verOps: true, flechas: true, linea: true, etiqueta: true, niveles: true, cajas: 'clic', alcance: 'todas', flot: true, tz: REPLAY ? 'broker' : 'local' };
  var cfg = {};
  (function () {
    var r = null;
    try { r = JSON.parse(localStorage.getItem(PFX + 'spotplus_cfg') || 'null'); } catch (e) { r = null; }
    for (var k in CFG0) cfg[k] = (r && r[k] !== undefined) ? r[k] : CFG0[k];
  })();
  function guardarCfg() { try { localStorage.setItem(PFX + 'spotplus_cfg', JSON.stringify(cfg)); } catch (e) {} }
  var manual = {};   // por operación: true = caja visible, false = oculta (lo que se elige con "#8 Mostrar / Ocultar")
  try { manual = JSON.parse(localStorage.getItem(PFX + 'spotplus_ops_manual') || '{}') || {}; } catch (e) { manual = {}; }
  function guardarManual() { try { localStorage.setItem(PFX + 'spotplus_ops_manual', JSON.stringify(manual)); } catch (e) {} }
  function opsFiltradas() { return opsRaw.filter(function (o) { return cfg.alcance !== 'curso' || o.estado === 'en_curso'; }); }
  function cajaAbierta(o) {
    if (cfg.cajas === 'nunca') return false;
    if (manual[o.id] !== undefined) return !!manual[o.id];
    return cfg.cajas === 'siempre' || o.estado === 'en_curso';
  }
  function reaplicarOps() { aplicarMarcas(); aplicarNiveles(); }

  // ---------- Zona horaria del eje, del cursor y del reloj ----------
  var TZS = [['local', 'Mi zona'], ['broker', 'Hora del bróker'], ['UTC', 'UTC'], ['America/Mexico_City', 'Ciudad de México'],
             ['America/New_York', 'Nueva York'], ['Europe/London', 'Londres'], ['Asia/Tokyo', 'Tokio']];
  var tzOk = false;
  TZS.forEach(function (z) { if (z[0] === cfg.tz) tzOk = true; });
  if (!tzOk) cfg.tz = 'local';
  var FORMATOS = {
    hm: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    hms: { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
    dia: { day: 'numeric' }, mes: { month: 'short' }, anio: { year: 'numeric' },
    cruz: { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    reloj: { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }
  };
  var fmtCache = {};
  function tzNombre() { return cfg.tz === 'local' ? undefined : (cfg.tz === 'broker' ? 'UTC' : cfg.tz); }
  function fechaTz(t, tipo) {
    try {
      var k = tipo + '|' + cfg.tz;
      if (!fmtCache[k]) { var o = {}; for (var a in FORMATOS[tipo]) o[a] = FORMATOS[tipo][a]; o.timeZone = tzNombre(); fmtCache[k] = new Intl.DateTimeFormat('es-MX', o); }
      var real = cfg.tz === 'broker' ? t : t - offsetSeg;   // t viene en "hora de gráfico" (hora real + desfase del bróker)
      return fmtCache[k].format(new Date(real * 1000));
    } catch (e) { return ''; }
  }
  function aplicarTz() {
    chart.applyOptions({
      localization: { timeFormatter: function (t) { return typeof t === 'number' ? fechaTz(t, 'cruz') : ''; } },
      timeScale: {
        tickMarkFormatter: function (t, tipo) {
          if (typeof t !== 'number') return '';
          return fechaTz(t, tipo === 0 ? 'anio' : tipo === 1 ? 'mes' : tipo === 2 ? 'dia' : tipo === 4 ? 'hms' : 'hm');
        }
      }
    });
  }
  var elTz = document.getElementById('tz'), elReloj = document.getElementById('reloj');
  TZS.forEach(function (z) { var op = document.createElement('option'); op.value = z[0]; op.textContent = z[1]; elTz.appendChild(op); });
  elTz.value = cfg.tz;
  elTz.addEventListener('change', function () { cfg.tz = elTz.value; guardarCfg(); aplicarTz(); pintarReloj(); });
  function pintarReloj() {
    var ahora = REPLAY ? (ultima ? ultima.time : 0) : Date.now() / 1000 + offsetSeg;
    var txt = '<b>' + fechaTz(ahora, 'reloj') + '</b>';
    if (ultima) txt += ' · hasta <b>' + fechaTz(ultima.time + tfSeg, tfSeg >= 86400 ? 'cruz' : 'hm') + '</b>';
    elReloj.innerHTML = txt;
  }
  setInterval(pintarReloj, 1000);
  aplicarTz(); pintarReloj();

  // ---------- Menu "Operaciones" ----------
  var opsBtn = document.getElementById('opsbtn'), opsMenu = document.getElementById('opsmenu');
  function pintarMenu() {
    var cs = opsMenu.querySelectorAll('input[data-c]');
    for (var i = 0; i < cs.length; i++) cs[i].checked = !!cfg[cs[i].getAttribute('data-c')];
    var ss = opsMenu.querySelectorAll('.seg');
    for (var j = 0; j < ss.length; j++) {
      var bs2 = ss[j].querySelectorAll('button');
      for (var q = 0; q < bs2.length; q++) bs2[q].className = bs2[q].getAttribute('data-v') === cfg[ss[j].getAttribute('data-s')] ? 'on' : '';
    }
    var ico = cfg.verOps ? ICONOS.ojo : ICONOS.ojoNo;
    opsBtn.firstChild.innerHTML = ico;
  }
  opsBtn.addEventListener('click', function (e) { e.stopPropagation(); opsMenu.style.display = opsMenu.style.display === 'block' ? 'none' : 'block'; });
  document.addEventListener('pointerdown', function (e) {
    if (opsMenu.style.display === 'block' && !opsMenu.contains(e.target) && !opsBtn.contains(e.target)) opsMenu.style.display = 'none';
  });
  opsMenu.addEventListener('change', function (e) {
    var c = e.target.getAttribute && e.target.getAttribute('data-c');
    if (!c) return;
    cfg[c] = e.target.checked; guardarCfg(); reaplicarOps(); pintarFlot(); pintarMenu(); ocultarChip();
  });
  opsMenu.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.seg button') : null;
    if (!b) return;
    var s2 = b.parentNode.getAttribute('data-s');
    cfg[s2] = b.getAttribute('data-v');
    if (s2 === 'cajas') { manual = {}; guardarManual(); }
    guardarCfg(); pintarMenu(); reaplicarOps(); ocultarChip();
  });
  pintarMenu();

  // Opciones de vista y alertas locales de precio.
  var chartMenu = document.getElementById('chartmenu'), chartMore = document.getElementById('chartmore');
  var panelFondo = document.getElementById('panel-fondo');
  var panelAlerta = document.getElementById('panel-alerta'), panelConfig = document.getElementById('panel-config');
  var alertaPrecio = document.getElementById('alerta-precio'), alertaError = document.getElementById('alerta-error');
  var alertasLista = document.getElementById('alertas-lista'), alertaToast = document.getElementById('alerta-toast');
  var lentesLista = document.getElementById('lentes-lista'), lentesInfo = document.getElementById('lentes-info');
  var precioPendiente = null, direccionPendiente = 'arriba', alertas = [], lineasAlertas = [], ultimoPrecioAlerta = null;
  var lentesRaw = [], zonasLentesRaw = [], temporalidadesFaltantes = [], visLentes = {}, coloresLentes = {};
  var COLORES_LENTE = ['#f59e0b', '#38bdf8', '#22c55e', '#c084fc', '#fb7185', '#14b8a6', '#f97316', '#a3e635', '#818cf8'];
  try {
    var visGuardadas = JSON.parse(localStorage.getItem(PFX + 'spotplus_lentes_vis') || '{}');
    if (visGuardadas && typeof visGuardadas === 'object') visLentes = visGuardadas;
  } catch (e) { mostrarToast('No se pudieron leer las preferencias de visibilidad de los lentes.'); }
  try {
    var coloresGuardados = JSON.parse(localStorage.getItem(PFX + 'spotplus_lentes_color') || '{}');
    if (coloresGuardados && typeof coloresGuardados === 'object') {
      Object.keys(coloresGuardados).forEach(function (nombre) {
        if (typeof coloresGuardados[nombre] === 'string' && /^#[0-9a-f]{6}$/i.test(coloresGuardados[nombre])) {
          coloresLentes[nombre] = coloresGuardados[nombre];
        }
      });
    }
  } catch (e) { mostrarToast('No se pudieron leer los colores guardados de los lentes.'); }
  var chartCfg = { cuadricula: true, autoEscala: true, lineaPrecio: true };
  try {
    var configGuardada = JSON.parse(localStorage.getItem(PFX + 'spotplus_chart_cfg') || 'null');
    if (configGuardada && typeof configGuardada === 'object') {
      chartCfg.cuadricula = configGuardada.cuadricula !== false;
      chartCfg.autoEscala = configGuardada.autoEscala !== false;
      chartCfg.lineaPrecio = configGuardada.lineaPrecio !== false;
    }
  } catch (e) { mostrarToast('No se pudo leer la configuración guardada del gráfico.'); }
  function guardarChartCfg() {
    try { localStorage.setItem(PFX + 'spotplus_chart_cfg', JSON.stringify(chartCfg)); }
    catch (e) { mostrarToast('No se pudo guardar la configuración del gráfico.'); }
  }
  function aplicarChartCfg() {
    var colorGrid = chartCfg.cuadricula ? 'rgba(42,46,57,0.18)' : 'rgba(0,0,0,0)';
    chart.applyOptions({
      grid: { vertLines: { color: colorGrid }, horzLines: { color: colorGrid } },
      rightPriceScale: { autoScale: chartCfg.autoEscala },
    });
    serie.applyOptions({ priceLineVisible: chartCfg.lineaPrecio });
  }
  function claveAlertas() { return PFX + 'spotplus_alertas_' + (simbolo || ''); }
  function guardarAlertas() {
    try { localStorage.setItem(claveAlertas(), JSON.stringify(alertas)); return true; }
    catch (e) { mostrarToast('No se pudieron guardar las alertas en este navegador.'); return false; }
  }
  function pintarAlertas() {
    lineasAlertas.forEach(function (l) { try { serie.removePriceLine(l); } catch (e) {} });
    lineasAlertas = [];
    alertas.forEach(function (a) {
      lineasAlertas.push(serie.createPriceLine({
        price: a.precio, color: a.disparada ? '#f0b90b' : (a.direccion === 'arriba' ? '#22c55e' : '#ef5350'),
        lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
        title: (a.disparada ? 'Aviso ' : 'Alerta ') + (a.direccion === 'arriba' ? '↑ ' : '↓ ') + fmt(a.precio),
      }));
    });
  }
  function cargarAlertas() {
    alertas = [];
    try {
      var guardadas = JSON.parse(localStorage.getItem(claveAlertas()) || '[]');
      if (Array.isArray(guardadas)) alertas = guardadas.filter(function (a) {
        return a && typeof a.precio === 'number' && Number.isFinite(a.precio) && a.precio > 0 &&
          (a.direccion === 'arriba' || a.direccion === 'abajo');
      });
    } catch (e) { alertas = []; mostrarToast('No se pudieron leer las alertas guardadas.'); }
    pintarAlertas();
    pintarListaAlertas();
  }
  var toastTimer = null;
  function mostrarToast(texto) {
    alertaToast.textContent = texto;
    alertaToast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { alertaToast.style.display = 'none'; }, 5000);
  }
  function evaluarAlertas(precio) {
    if (typeof precio !== 'number' || !Number.isFinite(precio)) return;
    if (ultimoPrecioAlerta !== null) {
      var nuevas = false;
      alertas.forEach(function (a) {
        var cruza = a.direccion === 'arriba'
          ? ultimoPrecioAlerta < a.precio && precio >= a.precio
          : ultimoPrecioAlerta > a.precio && precio <= a.precio;
        if (!a.disparada && cruza) {
          a.disparada = true;
          nuevas = true;
          mostrarToast('Alerta de ' + simbolo + ': ' + fmt(a.precio) + ' cruzado hacia ' + a.direccion + '.');
        }
      });
      if (nuevas) { guardarAlertas(); pintarAlertas(); pintarListaAlertas(); }
    }
    ultimoPrecioAlerta = precio;
  }
  function pintarListaAlertas() {
    while (alertasLista.firstChild) alertasLista.removeChild(alertasLista.firstChild);
    if (!alertas.length) {
      var vacio = document.createElement('div');
      vacio.className = 'alerta-item'; vacio.textContent = 'No hay alertas activas.';
      alertasLista.appendChild(vacio);
      return;
    }
    alertas.forEach(function (a, i) {
      var fila = document.createElement('div'), etiqueta = document.createElement('span'), borrar = document.createElement('button');
      fila.className = 'alerta-item';
      etiqueta.textContent = (a.disparada ? 'Avisada · ' : '') + (a.direccion === 'arriba' ? '↑ ' : '↓ ') + fmt(a.precio);
      borrar.type = 'button'; borrar.textContent = 'Eliminar'; borrar.setAttribute('data-borrar-alerta', String(i));
      fila.appendChild(etiqueta); fila.appendChild(borrar); alertasLista.appendChild(fila);
    });
  }
  function esLenteVisible(nombre) { return visLentes[nombre] !== false; }
  function lentesDeEstructura(tf) { return lentesRaw.filter(function (l) { return l.estructura === tf; }); }
  function lenteVisibleDeEstructura(tf) {
    var lista = lentesDeEstructura(tf);
    for (var i = 0; i < lista.length; i++) if (esLenteVisible(lista[i].nombre)) return lista[i];
    return null;
  }
  function visiblePorEstructura(tf) {
    var lista = lentesDeEstructura(tf);
    return !lista.length || lista.some(function (l) { return esLenteVisible(l.nombre); });
  }
  function rgbaLente(hex, alpha) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }
  function guardarVisLentes() {
    try { localStorage.setItem(PFX + 'spotplus_lentes_vis', JSON.stringify(visLentes)); }
    catch (e) { mostrarToast('No se pudieron guardar las preferencias de los lentes.'); }
  }
  function guardarColoresLentes() {
    try { localStorage.setItem(PFX + 'spotplus_lentes_color', JSON.stringify(coloresLentes)); }
    catch (e) { mostrarToast('No se pudieron guardar los colores de los lentes.'); }
  }
  function pintarLentesLista() {
    while (lentesLista.firstChild) lentesLista.removeChild(lentesLista.firstChild);
    if (!lentesRaw.length) {
      lentesLista.textContent = 'No hay lentes activos o todavía no hay velas suficientes.';
    } else {
      lentesRaw.forEach(function (l) {
        var fila = document.createElement('div'), check = document.createElement('input');
        var punto = document.createElement('span'), texto = document.createElement('span');
        var color = document.createElement('input'), quitar = document.createElement('button');
        fila.className = 'lente-item'; check.type = 'checkbox'; check.checked = esLenteVisible(l.nombre);
        check.setAttribute('data-lente', l.nombre);
        check.title = 'Mostrar u ocultar este lente';
        punto.className = 'lente-color'; punto.style.backgroundColor = l.color;
        texto.className = 'lente-texto';
        var ultimoPivote = l.pivotes && l.pivotes.length ? l.pivotes[l.pivotes.length - 1].clase : '';
        texto.textContent = l.nombre + ' · ' + l.vista + '/' + l.estructura + ' · ' + l.direccion + ' · ' + l.fase + (ultimoPivote ? ' · ' + ultimoPivote : '');
        color.type = 'color'; color.value = l.color; color.title = 'Cambiar color'; color.setAttribute('data-lente-color', l.nombre);
        quitar.type = 'button'; quitar.textContent = 'Quitar'; quitar.title = 'Ocultar este lente del gráfico'; quitar.setAttribute('data-quitar-lente', l.nombre);
        fila.appendChild(check); fila.appendChild(punto); fila.appendChild(texto); fila.appendChild(color); fila.appendChild(quitar);
        lentesLista.appendChild(fila);
      });
    }
    lentesInfo.textContent = temporalidadesFaltantes.length
      ? 'Sin datos suficientes: ' + temporalidadesFaltantes.join(', ')
      : '';
  }
  lentesLista.addEventListener('change', function (e) {
    var objetivo = e.target;
    var nombre = objetivo.getAttribute && (objetivo.getAttribute('data-lente') || objetivo.getAttribute('data-lente-color'));
    if (!nombre) return;
    if (objetivo.type === 'checkbox') {
      visLentes[nombre] = objetivo.checked;
      guardarVisLentes();
    } else if (objetivo.type === 'color') {
      coloresLentes[nombre] = objetivo.value;
      guardarColoresLentes();
      lentesRaw.forEach(function (l) { if (l.nombre === nombre) l.color = objetivo.value; });
    }
    pintarLentesLista(); aplicarBot();
  });
  lentesLista.addEventListener('click', function (e) {
    var boton = e.target.closest && e.target.closest('[data-quitar-lente]');
    var nombre = boton && boton.getAttribute('data-quitar-lente');
    if (!nombre) return;
    visLentes[nombre] = false;
    guardarVisLentes(); pintarLentesLista(); aplicarBot();
  });
  function abrirPanel(tipo) {
    chartMenu.style.display = 'none';
    panelAlerta.style.display = tipo === 'alerta' ? 'block' : 'none';
    panelConfig.style.display = tipo === 'config' ? 'block' : 'none';
    panelFondo.style.display = 'flex';
    if (tipo === 'alerta') {
      alertaPrecio.value = precioPendiente ? precioPendiente.toFixed(precision(precioPendiente)) : '';
      alertaError.textContent = '';
      direccionPendiente = 'arriba';
      panelAlerta.querySelectorAll('.direccion button').forEach(function (b) { b.className = b.getAttribute('data-direccion') === direccionPendiente ? 'on' : ''; });
      alertaPrecio.focus();
    } else {
      document.getElementById('cfg-cuadricula').checked = chartCfg.cuadricula;
      document.getElementById('cfg-autoescala').checked = chartCfg.autoEscala;
      document.getElementById('cfg-linea-precio').checked = chartCfg.lineaPrecio;
      pintarListaAlertas();
      pintarLentesLista();
    }
  }
  function cerrarPanel() { panelFondo.style.display = 'none'; }
  function abrirMenuGrafico(x, y, precio) {
    precioPendiente = (typeof precio === 'number' && Number.isFinite(precio) && precio > 0) ? precio : (ultima ? ultima.close : null);
    var r = document.getElementById('area').getBoundingClientRect();
    chartMenu.style.display = 'block';
    chartMenu.style.left = Math.max(4, Math.min(r.width - 248, x)) + 'px';
    chartMenu.style.top = Math.max(4, Math.min(r.height - chartMenu.offsetHeight - 4, y)) + 'px';
    chartMenu.style.right = 'auto';
  }
  chartMore.addEventListener('click', function (e) {
    e.stopPropagation();
    if (chartMenu.style.display === 'block') chartMenu.style.display = 'none';
    else abrirMenuGrafico(document.getElementById('area').clientWidth - 250, 44, bid);
  });
  cont.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var r = cont.getBoundingClientRect(), precio = serie.coordinateToPrice(e.clientY - r.top);
    abrirMenuGrafico(e.clientX - document.getElementById('area').getBoundingClientRect().left,
      e.clientY - document.getElementById('area').getBoundingClientRect().top, precio);
  });
  document.addEventListener('pointerdown', function (e) {
    if (chartMenu.style.display === 'block' && !chartMenu.contains(e.target) && !chartMore.contains(e.target)) chartMenu.style.display = 'none';
  });
  chartMenu.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-chart]') : null;
    if (!b) return;
    var accion = b.getAttribute('data-chart');
    if (accion === 'reset') {
      chartMenu.style.display = 'none';
      chart.priceScale('right').applyOptions({ autoScale: true });
      chart.timeScale().fitContent();
      chartCfg.autoEscala = true; guardarChartCfg();
      document.getElementById('cfg-autoescala').checked = true;
    } else if (accion === 'alerta') abrirPanel('alerta');
    else if (accion === 'alerta-actual') { precioPendiente = bid || (ultima ? ultima.close : null); abrirPanel('alerta'); }
    else if (accion === 'config') abrirPanel('config');
  });
  panelFondo.addEventListener('click', function (e) { if (e.target === panelFondo) cerrarPanel(); });
  document.getElementById('alerta-cancelar').addEventListener('click', cerrarPanel);
  document.getElementById('config-cerrar').addEventListener('click', cerrarPanel);
  panelAlerta.querySelectorAll('.direccion button').forEach(function (b) {
    b.addEventListener('click', function () {
      direccionPendiente = b.getAttribute('data-direccion');
      panelAlerta.querySelectorAll('.direccion button').forEach(function (x) { x.className = x === b ? 'on' : ''; });
    });
  });
  document.getElementById('alerta-guardar').addEventListener('click', function () {
    var precio = Number(alertaPrecio.value);
    if (!Number.isFinite(precio) || precio <= 0) { alertaError.textContent = 'Ingresa un precio mayor que cero.'; return; }
    alertas.push({ precio: precio, direccion: direccionPendiente, disparada: false });
    if (!guardarAlertas()) { alertas.pop(); return; }
    pintarAlertas(); pintarListaAlertas(); cerrarPanel();
  });
  alertasLista.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-borrar-alerta]') : null;
    if (!b) return;
    var indice = Number(b.getAttribute('data-borrar-alerta'));
    if (!Number.isInteger(indice) || indice < 0 || indice >= alertas.length) return;
    alertas.splice(indice, 1); guardarAlertas(); pintarAlertas(); pintarListaAlertas();
  });
  [['cfg-cuadricula', 'cuadricula'], ['cfg-autoescala', 'autoEscala'], ['cfg-linea-precio', 'lineaPrecio']].forEach(function (par) {
    document.getElementById(par[0]).addEventListener('change', function (e) {
      chartCfg[par[1]] = e.target.checked; guardarChartCfg(); aplicarChartCfg();
    });
  });
  aplicarChartCfg();

  // ---------- Etiqueta "#8 Mostrar / Ocultar" sobre cada operación ----------
  var chip = document.getElementById('chip'), chipTimer = null, chipOp = null;
  function puntosOp(o) {
    var res = [];
    var xa = xDeTiempo(o.tA + offsetSeg), ya = serie.priceToCoordinate(o.entrada);
    if (xa !== null && ya !== null && ya !== undefined) res.push({ x: xa, y: ya });
    if (o.estado !== 'en_curso' && o.tC !== null && o.tC !== undefined && o.cierre !== null && o.cierre !== undefined) {
      var xc = xDeTiempo(o.tC + offsetSeg), yc = serie.priceToCoordinate(o.cierre);
      if (xc !== null && yc !== null && yc !== undefined) res.push({ x: xc, y: yc });
    }
    return res;
  }
  function opBajo(mx, my) {
    if (!cfg.verOps || cfg.cajas === 'nunca') return null;
    var lista = opsFiltradas();
    for (var i = lista.length - 1; i >= 0; i--) {
      var ps = puntosOp(lista[i]);
      for (var j = 0; j < ps.length; j++) if (Math.abs(mx - ps[j].x) < 14 && Math.abs(my - ps[j].y) < 30) return { o: lista[i], x: ps[j].x, y: ps[j].y };
    }
    return null;
  }
  function pintarChip() {
    if (!chipOp) return;
    var abierta = cajaAbierta(chipOp);
    chip.innerHTML = '<b>#' + chipOp.id + '</b><svg viewBox="0 0 24 24">' + (abierta ? ICONOS.ojoNo : ICONOS.ojo) + '</svg><span>' + (abierta ? 'Ocultar' : 'Mostrar') + '</span>';
  }
  function mostrarChip(h) {
    clearTimeout(chipTimer); chipTimer = null;
    chipOp = h.o; pintarChip();
    chip.style.display = 'flex';
    chip.style.left = Math.max(4, Math.min(cont.clientWidth - 140, h.x - 58)) + 'px';
    chip.style.top = Math.max(4, h.y - 46) + 'px';
  }
  function ocultarChip() { clearTimeout(chipTimer); chipTimer = null; chip.style.display = 'none'; chipOp = null; }
  function programarOcultar() { if (!chipTimer && chip.style.display === 'flex') chipTimer = setTimeout(ocultarChip, 400); }
  cont.addEventListener('mousemove', function (e) {
    if (herr !== 'cursor') return;
    var r = cont.getBoundingClientRect();
    var h = opBajo(e.clientX - r.left, e.clientY - r.top);
    if (h) mostrarChip(h); else programarOcultar();
  });
  cont.addEventListener('click', function (e) {   // en pantallas táctiles no hay "pasar el mouse"
    if (herr !== 'cursor') return;
    var r = cont.getBoundingClientRect();
    var h = opBajo(e.clientX - r.left, e.clientY - r.top);
    if (h) mostrarChip(h);
  });
  chip.addEventListener('mouseenter', function () { clearTimeout(chipTimer); chipTimer = null; });
  chip.addEventListener('mouseleave', programarOcultar);
  chip.addEventListener('click', function () {
    if (!chipOp) return;
    manual[chipOp.id] = !cajaAbierta(chipOp);
    guardarManual(); pintarChip();
  });

  // ---------- Barra flotante de herramientas (arrastrable) ----------
  var flot = document.getElementById('flot'), area = document.getElementById('area');
  function posFlot() {
    var g = null;
    try { g = JSON.parse(localStorage.getItem(PFX + 'spotplus_flot') || 'null'); } catch (e) { g = null; }
    var W = cont.clientWidth, H = cont.clientHeight;
    flot.style.transform = 'none';
    if (g && typeof g.x === 'number' && typeof g.y === 'number') {
      flot.style.left = Math.max(0, Math.min(W - 60, g.x)) + 'px';
      flot.style.top = Math.max(0, Math.min(H - 40, g.y)) + 'px';
    } else {
      // Junto a la leyenda si cabe (sin tapar el texto OHLC ni el botón Operaciones); si no, debajo de ella.
      var ley = document.getElementById('leyenda'), anchoFlot = flot.offsetWidth || 330;
      var finLey = ley ? (ley.getBoundingClientRect().right - area.getBoundingClientRect().left) : 0;
      var x0 = Math.max(finLey, document.getElementById('lg-ohlc').getBoundingClientRect().right - area.getBoundingClientRect().left) + 20;
      if (x0 + anchoFlot <= W - 84 - 150) { flot.style.left = x0 + 'px'; flot.style.top = '8px'; }
      else { flot.style.left = '12px'; flot.style.top = '84px'; }
    }
  }
  function pintarFlot() {
    flot.style.display = (cfg.flot && cont.clientWidth >= 520) ? 'flex' : 'none';
    var b = document.getElementById('b-flot');
    if (b) b.style.color = cfg.flot ? '#fff' : '';
  }
  (function () {
    var arrastre = null;
    var grip = document.getElementById('grip');
    grip.addEventListener('pointerdown', function (e) {
      var r = flot.getBoundingClientRect(), a = area.getBoundingClientRect();
      flot.style.transform = 'none';
      flot.style.left = (r.left - a.left) + 'px'; flot.style.top = (r.top - a.top) + 'px';
      arrastre = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      try { grip.setPointerCapture(e.pointerId); } catch (x) {}
      grip.style.cursor = 'grabbing';
      e.preventDefault();
    });
    grip.addEventListener('pointermove', function (e) {
      if (!arrastre) return;
      var a = area.getBoundingClientRect();
      var x = Math.max(0, Math.min(a.width - flot.offsetWidth, e.clientX - a.left - arrastre.dx));
      var y = Math.max(0, Math.min(a.height - flot.offsetHeight, e.clientY - a.top - arrastre.dy));
      flot.style.left = x + 'px'; flot.style.top = y + 'px';
    });
    function soltar() {
      if (!arrastre) return;
      arrastre = null; grip.style.cursor = 'grab';
      try { localStorage.setItem(PFX + 'spotplus_flot', JSON.stringify({ x: parseFloat(flot.style.left), y: parseFloat(flot.style.top) })); } catch (e) {}
    }
    grip.addEventListener('pointerup', soltar);
    grip.addEventListener('pointercancel', soltar);
    grip.addEventListener('dblclick', function () { try { localStorage.removeItem(PFX + 'spotplus_flot'); } catch (e) {} posFlot(); });
  })();
  window.addEventListener('resize', function () { posFlot(); pintarFlot(); });
  posFlot(); pintarFlot();
  document.getElementById('b-flot').addEventListener('click', function () { cfg.flot = !cfg.flot; guardarCfg(); pintarFlot(); pintarMenu(); });

  // ---------- WebSocket ----------
  function suscribir() {
    if (!abierto || !ws) return;
    if (suscrito && suscrito !== simbolo) ws.send(JSON.stringify({ type: 'desuscribir', simbolo: suscrito }));
    if (simbolo && suscrito !== simbolo) {
      ws.send(JSON.stringify({ type: 'suscribir', simbolo: simbolo }));
      suscrito = simbolo;
    }
  }

  function conectar() {
    if (sinAuth) return;
    try { ws = new WebSocket(WS_URL); } catch (e) { programar(); return; }
    ws.onopen = function () {
      abierto = true; suscrito = null;
      ws.send(JSON.stringify({ type: 'auth', key: KEY }));
      suscribir();
      espera = 1000;
      if (huboConexion) enviar({ type: 'reconectado' });   // hay que rellenar velas perdidas
      huboConexion = true;
    };
    ws.onmessage = function (ev) {
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d && d.type === 'tick' && d.simbolo === simbolo) aplicarTick(d);
    };
    ws.onclose = function (ev) {
      abierto = false; suscrito = null;
      if (ev && ev.code === 1008) { sinAuth = true; return; }
      programar();
    };
    ws.onerror = function () {};
  }
  function programar() {
    if (timerReconexion || sinAuth) return;
    timerReconexion = setTimeout(function () { timerReconexion = null; conectar(); }, espera);
    espera = Math.min(espera * 1.6, 5000);
  }

  function aplicarTick(d) {
    ultimoTickMs = Date.now();
    bid = d.bid; ask = d.ask;
    if (!offsetListo) {
      var dif = d.t - Date.now() / 1000;
      if (dif > -3600 && dif < 4 * 3600) { offsetSeg = Math.round(dif / 900) * 900; offsetListo = true; aplicarMarcas(); }
    }
    if (!ultima) return;
    var precio = d.bid;
    var cubeta = Math.floor(d.t / tfSeg) * tfSeg;
    if (cubeta < ultima.time) return;   // tick atrasado: no reescribimos velas viejas
    if (cubeta > ultima.time) {
      ultima = { time: cubeta, open: precio, high: precio, low: precio, close: precio };
      datos.push({ time: ultima.time, open: precio, high: precio, low: precio, close: precio });
    } else {
      if (precio > ultima.high) ultima.high = precio;
      if (precio < ultima.low) ultima.low = precio;
      ultima.close = precio;
      if (datos.length) datos[datos.length - 1] = { time: ultima.time, open: ultima.open, high: ultima.high, low: ultima.low, close: ultima.close };
    }
    serie.update({ time: ultima.time, open: ultima.open, high: ultima.high, low: ultima.low, close: ultima.close });
    evaluarAlertas(precio);
    pintarPrecios();
    if (!hover) pintarOHLC(ultima);
  }

  // ---------- Operaciones: flechas, líneas SL/TP y cajas ----------
  function aplicarMarcas() {
    if (!datos.length || !cfg.verOps || !cfg.flechas) { serie.setMarkers([]); return; }
    var primero = datos[0].time;
    var m = [];
    function poner(tReal, entrada, compra, texto) {
      var t = Math.floor((tReal + offsetSeg) / tfSeg) * tfSeg;
      if (t < primero) return;
      var arriba = entrada ? compra : !compra;   // compra: entra flecha arriba; sale flecha abajo
      m.push({
        time: t,
        position: arriba ? 'belowBar' : 'aboveBar',
        shape: arriba ? 'arrowUp' : 'arrowDown',
        color: entrada ? (compra ? '#2962ff' : '#ef4444') : '#f0b90b',
        text: texto || '',
        size: 1.4,
      });
    }
    opsFiltradas().forEach(function (o) {
      var compra = o.lado === 'compra';
      poner(o.tA, true, compra, '');
      if (o.estado !== 'en_curso' && o.tC !== null && o.tC !== undefined) {
        var txt = (o.profit === null || o.profit === undefined) ? '' : ((o.profit >= 0 ? '+' : '') + o.profit.toFixed(2));
        poner(o.tC, false, compra, txt);
      }
    });
    m.sort(function (a, b) { return a.time - b.time; });
    serie.setMarkers(m);
  }

  function aplicarNiveles() {
    lineasNivel.forEach(function (l) { try { serie.removePriceLine(l); } catch (e) {} });
    lineasNivel = [];
    if (!cfg.verOps || !cfg.niveles) return;
    opsRaw.forEach(function (o) {
      if (o.estado !== 'en_curso') return;
      var nv = [[o.entrada, '#2962ff', 'Entrada'], [o.sl, '#ef4444', 'SL'], [o.tp, '#22c55e', 'TP']];
      nv.forEach(function (n) {
        if (n[0] === null || n[0] === undefined) return;
        lineasNivel.push(serie.createPriceLine({ price: n[0], color: n[1], lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: n[2] }));
      });
    });
  }

  // ---------- Lo que piensa el bot: zonas, niveles y motivos ----------
  var ESTADO_BOT = { dentro: 'precio en zona', esperando: 'esperando', esperar_barrido: 'esperar barrido', confirmada: 'CONFIRMADA' };
  function aplicarBot() {
    lineasBot.forEach(function (l) { try { serie.removePriceLine(l); } catch (e) {} });
    lineasBot = [];
    botRaw.forEach(function (e) {
      if (e.estado !== 'confirmada' || !visiblePorEstructura(e.zona_tf)) return;   // entrada/SL/TP solo cuando el bot confirmó
      var lente = lenteVisibleDeEstructura(e.zona_tf);
      function linea(precio, color, titulo) {
        if (typeof precio !== 'number') return;
        lineasBot.push(serie.createPriceLine({ price: precio, color: color, lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: titulo }));
      }
      linea(e.entrada, lente ? lente.color : '#2962ff', (lente ? lente.nombre + ' ' : '') + 'Entrada');
      linea(e.sl, '#ef4444', 'Bot SL');
      (e.operaciones || []).forEach(function (o) { linea(o.tp, '#22c55e', 'Bot TP ' + (o.nombre || '')); });
    });
  }

  function dibujarBot(w) {
    if (!botRaw.length || !datos.length) return;
    var anchoEscala = 60;
    try { anchoEscala = chart.priceScale('right').width(); } catch (e) {}
    var xMax = w - anchoEscala;
    var n = datos.length - 1;
    // Las zonas son "de ahora" (el bot no guarda desde que vela nacen): se anclan a las ultimas ~80 velas.
    var xa = xDeTiempo(datos[Math.max(0, n - 80)].time);
    if (xa === null || xa === undefined) return;
    var x1 = Math.max(xa, 0);
    if (xMax - x1 < 10) return;
    botRaw.forEach(function (e) {
      var r = e.zona_rango;
      if (!r || r.length < 2 || !visiblePorEstructura(e.zona_tf)) return;
      var lente = lenteVisibleDeEstructura(e.zona_tf);
      var color = lente ? lente.color : (e.direccion === 'alcista' ? '#26a69a' : '#ef5350');
      var yA = serie.priceToCoordinate(r[1]), yB = serie.priceToCoordinate(r[0]);
      if (yA === null || yB === null) return;
      var alc = e.direccion === 'alcista';
      var conf = e.estado === 'confirmada';
      var yTop = Math.min(yA, yB), alto = Math.max(Math.abs(yB - yA), 2);
      ctx.fillStyle = lente ? rgbaLente(color, 0.15) : (alc ? 'rgba(38,166,154,0.16)' : 'rgba(239,83,80,0.16)');
      ctx.fillRect(x1, yTop, xMax - x1, alto);
      ctx.strokeStyle = color;
      ctx.lineWidth = conf ? 2 : 1;
      ctx.setLineDash(conf ? [] : [5, 4]);
      ctx.strokeRect(x1, yTop, xMax - x1, alto);
      ctx.setLineDash([]);
      var txt = (lente ? lente.nombre + ' · ' : '') + (e.zona || 'Zona') + ' ' + (e.zona_tf || '') + ' - ' + (ESTADO_BOT[e.estado] || e.estado || '') + ' - ' + (alc ? 'compra' : 'venta') + ' - score ' + (e.score || 0);
      ctx.font = 'bold 11px sans-serif';
      var ancho = ctx.measureText(txt).width + 10;
      ctx.fillStyle = lente ? color : (conf ? 'rgba(41,98,255,0.95)' : 'rgba(60,66,80,0.95)');
      ctx.fillRect(x1, yTop - 17, ancho, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, x1 + 5, yTop - 5);
      // Motivos: por que el bot ve esta zona (y por que espera, si espera)
      var motivos = (e.confluencias || []).concat(e.notas || []).slice(0, 4);
      ctx.font = '10px sans-serif';
      var y = alto >= 44 ? yTop + 13 : yTop + alto + 12;
      motivos.forEach(function (m) {
        var t = String(m);
        var tw = ctx.measureText(t).width + 8;
        ctx.fillStyle = 'rgba(11,14,19,0.78)';
        ctx.fillRect(x1 + 4, y - 10, tw, 13);
        ctx.fillStyle = 'rgba(232,235,242,0.95)';
        ctx.fillText(t, x1 + 8, y);
        y += 14;
      });
    });
  }

  function dibujarLentes(w) {
    if (!datos.length) return;
    var anchoEscala = 60;
    try { anchoEscala = chart.priceScale('right').width(); } catch (e) {}
    var xMax = w - anchoEscala;
    var inicio = xDeTiempo(datos[Math.max(0, datos.length - 81)].time);
    var xInicio = Math.max(0, inicio === null ? 0 : inicio);
    var tiempoActual = datos[datos.length - 1].time;

    zonasLentesRaw.forEach(function (z) {
      var duplicada = botRaw.some(function (e) {
        return e.zona_tf === z.estructura && e.zona_rango && Math.abs(e.zona_rango[0] - z.rango[0]) < 0.00001 &&
          Math.abs(e.zona_rango[1] - z.rango[1]) < 0.00001;
      });
      if (duplicada || !visiblePorEstructura(z.estructura) || xMax - xInicio < 10) return;
      var lente = lenteVisibleDeEstructura(z.estructura);
      var color = lente ? lente.color : '#9aa0ad';
      var yA = serie.priceToCoordinate(z.rango[0]), yB = serie.priceToCoordinate(z.rango[1]);
      if (yA === null || yB === null) return;
      var yTop = Math.min(yA, yB), alto = Math.max(Math.abs(yB - yA), 2);
      ctx.fillStyle = rgbaLente(color, 0.11); ctx.fillRect(xInicio, yTop, xMax - xInicio, alto);
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.strokeRect(xInicio, yTop, xMax - xInicio, alto); ctx.setLineDash([]);
    });

    lentesRaw.forEach(function (l) {
      if (!esLenteVisible(l.nombre)) return;
      var puntos = [];
      var pivotesVisibles = REPLAY
        ? l.pivotes.filter(function (p) { return !p.confirmacion || p.confirmacion <= tiempoActual; })
        : l.pivotes;
      pivotesVisibles.slice(-8).forEach(function (p) {
        var x = xDeTiempo(p.time), y = serie.priceToCoordinate(p.precio);
        if (x === null || y === null || x < 0 || x > xMax) return;
        puntos.push({ x: x, y: y, p: p });
      });
      if (puntos.length) {
        ctx.strokeStyle = rgbaLente(l.color, 0.75); ctx.lineWidth = 1.5; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(puntos[0].x, puntos[0].y);
        for (var i = 1; i < puntos.length; i++) ctx.lineTo(puntos[i].x, puntos[i].y);
        ctx.stroke();
        puntos.forEach(function (p) {
          ctx.fillStyle = l.color; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 6.2832); ctx.fill();
        });
      }
      var quiebresVisibles = REPLAY
        ? l.quiebres.filter(function (q) { return q.time <= tiempoActual; })
        : l.quiebres;
      var q = quiebresVisibles.length ? quiebresVisibles[quiebresVisibles.length - 1] : null;
      if (q) {
        var x = xDeTiempo(q.time), y = serie.priceToCoordinate(q.precio);
        if (x !== null && y !== null && x >= 0 && x <= xMax) {
          ctx.strokeStyle = rgbaLente(l.color, 0.62); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(xMax, y); ctx.stroke(); ctx.setLineDash([]);
        }
      }
    });
  }

  function dibujarOps(w) {
    if (!cfg.verOps || !datos.length) return;
    var anchoEscala = 60;
    try { anchoEscala = chart.priceScale('right').width(); } catch (e) {}
    var xMax = w - anchoEscala;
    var precioAct = bid !== null ? bid : (ultima ? ultima.close : null);
    var xUlt = xDeTiempo(datos[datos.length - 1].time);
    opsFiltradas().forEach(function (o) {
      var corriendo = o.estado === 'en_curso';
      if (!cajaAbierta(o)) return;   // solo flechas; la caja se ve con "#id Mostrar"
      var compra = o.lado === 'compra';
      var xa = xDeTiempo(o.tA + offsetSeg);
      var xb = corriendo ? xUlt : ((o.tC === null || o.tC === undefined) ? null : xDeTiempo(o.tC + offsetSeg));
      if (xa === null) return;
      if (xb === null || xb === undefined) xb = xa + 4;
      if (xb < xa + 4) xb = xa + 4;
      var yE = serie.priceToCoordinate(o.entrada);
      if (yE === null) return;
      var salida = corriendo ? precioAct : o.cierre;
      var ySal = (salida === null || salida === undefined) ? null : serie.priceToCoordinate(salida);
      var gana = (salida === null || salida === undefined) ? true : (compra ? salida >= o.entrada : salida <= o.entrada);
      var ySL = (o.sl === null || o.sl === undefined) ? null : serie.priceToCoordinate(o.sl);
      var yTP = (o.tp === null || o.tp === undefined) ? null : serie.priceToCoordinate(o.tp);
      var x1 = Math.max(xa, 0), x2 = Math.min(xb, xMax);
      if (x2 <= x1) return;
      var ys = [yE];
      function caja(y, relleno, borde) {
        if (y === null) return;
        var top = Math.min(yE, y), alto = Math.abs(y - yE);
        if (corriendo) {
          ctx.strokeStyle = borde; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
          ctx.strokeRect(x1, top, x2 - x1, alto);
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = relleno; ctx.fillRect(x1, top, x2 - x1, alto);
          ctx.strokeStyle = borde; ctx.lineWidth = 1; ctx.setLineDash([]);
          ctx.strokeRect(x1, top, x2 - x1, alto);
        }
        ys.push(y);
      }
      if (yTP !== null || ySL !== null) { caja(yTP, VERDE, VERDE_L); caja(ySL, ROJO, ROJO_L); }
      else if (ySal !== null) caja(ySal, gana ? VERDE : ROJO, gana ? VERDE_L : ROJO_L);
      // línea de entrada
      ctx.strokeStyle = 'rgba(232,235,242,0.8)'; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x1, yE); ctx.lineTo(x2, yE); ctx.stroke();
      // línea punteada entrada -> salida (o precio actual si va corriendo)
      if (ySal !== null && cfg.linea) {
        ctx.setLineDash([5, 4]); ctx.strokeStyle = gana ? '#22c55e' : '#ef4444'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(xa, yE); ctx.lineTo(xb, ySal); ctx.stroke(); ctx.setLineDash([]);
      }
      // etiqueta
      if (!cfg.etiqueta) return;
      var pts = (salida === null || salida === undefined) ? null : (compra ? salida - o.entrada : o.entrada - salida);
      var ganancia = (o.profit !== null && o.profit !== undefined) ? o.profit : null;
      var txt = (compra ? 'COMPRA' : 'VENTA') + (o.vol ? ' ' + o.vol : '');
      txt += corriendo ? '  · EN CURSO' : (o.res ? '  · ' + o.res : '');
      if (ganancia !== null) txt += '  ' + (ganancia >= 0 ? '+' : '') + ganancia.toFixed(2);
      else if (pts !== null) txt += '  ' + (pts >= 0 ? '+' : '') + pts.toFixed(2) + ' pts';
      var yTop = Math.min.apply(null, ys);
      ctx.font = 'bold 11px sans-serif';
      var ancho = ctx.measureText(txt).width + 10;
      ctx.fillStyle = gana ? 'rgba(38,166,154,0.95)' : 'rgba(239,83,80,0.95)';
      ctx.fillRect(x1, yTop - 17, ancho, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, x1 + 5, yTop - 5);
    });
  }

  // ---------- Dibujos ----------
  var dib = [];            // {k, a:{t,p}, b:{t,p}, pts?, s?}
  var enCurso = null;
  var herr = 'cursor';
  var visibles = true;
  var NIVELES_FIB = [
    [0, '#9aa0ad'], [0.236, '#f23645'], [0.382, '#ff9800'], [0.5, '#4caf50'],
    [0.618, '#00bcd4'], [0.786, '#2962ff'], [1, '#9aa0ad']
  ];

  function claveDib() { return PFX + 'spotplus_dib_' + (simbolo || ''); }
  function guardarDib() { try { localStorage.setItem(claveDib(), JSON.stringify(dib)); } catch (e) {} }
  function cargarDib() {
    dib = [];
    try { var r = localStorage.getItem(claveDib()); if (r) dib = JSON.parse(r) || []; } catch (e) { dib = []; }
  }

  function xDeTiempo(t) {
    var ts = chart.timeScale();
    var x = ts.timeToCoordinate(t);
    if (x !== null && x !== undefined) return x;
    if (!datos.length) return null;
    var n = datos.length - 1;
    if (t >= datos[n].time) return ts.logicalToCoordinate(n + (t - datos[n].time) / tfSeg);
    if (t <= datos[0].time) return ts.logicalToCoordinate((t - datos[0].time) / tfSeg);
    var lo = 0, hi = n;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (datos[mid].time <= t) lo = mid; else hi = mid; }
    return ts.logicalToCoordinate(lo);
  }
  function tiempoDeX(x) {
    var l = chart.timeScale().coordinateToLogical(x);
    if (l === null || l === undefined || !datos.length) return null;
    var i = Math.round(l), n = datos.length - 1;
    if (i < 0) return datos[0].time + i * tfSeg;
    if (i > n) return datos[n].time + (i - n) * tfSeg;
    return datos[i].time;
  }
  function punto(e) {
    var r = cont.getBoundingClientRect();
    var t = tiempoDeX(e.clientX - r.left);
    var p = serie.coordinateToPrice(e.clientY - r.top);
    if (t === null || p === null || p === undefined) return null;
    return { t: t, p: p };
  }
  function geom(d) {
    var g = { x1: xDeTiempo(d.a.t), y1: serie.priceToCoordinate(d.a.p), x2: xDeTiempo(d.b.t), y2: serie.priceToCoordinate(d.b.p) };
    if (g.x1 === null || g.y1 === null || g.x2 === null || g.y2 === null) return null;
    return g;
  }
  function extender(g, w, ambos) {
    var dx = g.x2 - g.x1, dy = g.y2 - g.y1;
    if (dx === 0 && dy === 0) return [g.x1, g.y1, g.x2, g.y2];
    var L = (w + 2000) / Math.max(Math.abs(dx), Math.abs(dy));
    return [ambos ? g.x1 - dx * L : g.x1, ambos ? g.y1 - dy * L : g.y1, g.x1 + dx * L, g.y1 + dy * L];
  }
  function posLS(d) {
    var dp = Math.abs(d.b.p - d.a.p), larga = d.k === 'long';
    return { tp: larga ? d.a.p + dp : d.a.p - dp, sl: larga ? d.a.p - dp / RR : d.a.p + dp / RR };
  }
  function distSeg(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    var t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
    var cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
  }
  function golpe(d, mx, my) {
    var g = geom(d); if (!g) return false;
    var c = 8, k = d.k;
    if (k === 'h') return Math.abs(my - g.y1) < c;
    if (k === 'v') return Math.abs(mx - g.x1) < c;
    if (k === 'r') return mx >= g.x1 - c && Math.abs(my - g.y1) < c;
    if (k === 't' || k === 'arrow') return distSeg(mx, my, g.x1, g.y1, g.x2, g.y2) < c;
    if (k === 'ray' || k === 'ext') { var e = extender(g, cont.clientWidth, k === 'ext'); return distSeg(mx, my, e[0], e[1], e[2], e[3]) < c; }
    if (k === 'tx') return Math.abs(mx - g.x1) < 70 && Math.abs(my - g.y1) < 14;
    if (k === 'p') {
      var ant = null;
      for (var i = 0; i < (d.pts || []).length; i++) {
        var x = xDeTiempo(d.pts[i].t), y = serie.priceToCoordinate(d.pts[i].p);
        if (x === null || y === null) { ant = null; continue; }
        if (ant && distSeg(mx, my, ant[0], ant[1], x, y) < c) return true;
        ant = [x, y];
      }
      return false;
    }
    var ys = [g.y1, g.y2];
    if (k === 'long' || k === 'short') {
      var ls = posLS(d);
      ys.push(serie.priceToCoordinate(ls.tp), serie.priceToCoordinate(ls.sl));
    }
    var ay = Math.min.apply(null, ys.filter(function (v) { return v !== null; }));
    var by = Math.max.apply(null, ys.filter(function (v) { return v !== null; }));
    var ax = Math.min(g.x1, g.x2), bx = Math.max(g.x1, g.x2);
    return mx >= ax - c && mx <= bx + c && my >= ay - c && my <= by + c;
  }

  function etiqueta(texto, x, y, color) {
    ctx.font = '11px sans-serif';
    ctx.fillStyle = color;
    ctx.fillText(texto, x, y);
  }
  function flecha(x1, y1, x2, y2, color) {
    var ang = Math.atan2(y2 - y1, x2 - x1), l = 11;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - l * Math.cos(ang - 0.45), y2 - l * Math.sin(ang - 0.45));
    ctx.lineTo(x2 - l * Math.cos(ang + 0.45), y2 - l * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }
  function linea(x1, y1, x2, y2, color, ancho) {
    ctx.strokeStyle = color; ctx.lineWidth = ancho; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  function dibujarUno(d, w, h) {
    var g = geom(d);
    if (!g) return;
    var k = d.k;
    if (k === 'h') {
      linea(0, g.y1, w, g.y1, '#f0b90b', 1);
      etiqueta(fmt(d.a.p), 44, g.y1 - 4, '#f0b90b');
    } else if (k === 'v') {
      linea(g.x1, 0, g.x1, h, '#f0b90b', 1);
    } else if (k === 'r') {
      linea(g.x1, g.y1, w, g.y1, '#f0b90b', 1);
    } else if (k === 't') {
      linea(g.x1, g.y1, g.x2, g.y2, '#2962ff', 2);
      ctx.fillStyle = '#2962ff';
      ctx.beginPath(); ctx.arc(g.x1, g.y1, 3, 0, 6.3); ctx.fill();
      ctx.beginPath(); ctx.arc(g.x2, g.y2, 3, 0, 6.3); ctx.fill();
    } else if (k === 'ray' || k === 'ext') {
      var e = extender(g, w, k === 'ext');
      linea(e[0], e[1], e[2], e[3], '#2962ff', 2);
    } else if (k === 'arrow') {
      linea(g.x1, g.y1, g.x2, g.y2, '#f0b90b', 2);
      flecha(g.x1, g.y1, g.x2, g.y2, '#f0b90b');
    } else if (k === 'z') {
      var zx = Math.min(g.x1, g.x2), zy = Math.min(g.y1, g.y2), zw = Math.abs(g.x2 - g.x1), zh = Math.abs(g.y2 - g.y1);
      ctx.fillStyle = 'rgba(103,58,183,0.38)'; ctx.fillRect(zx, zy, zw, zh);
      ctx.strokeStyle = 'rgba(167,139,250,0.95)'; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.strokeRect(zx, zy, zw, zh);
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(167,139,250,0.7)';
      ctx.beginPath(); ctx.moveTo(zx, zy + zh / 2); ctx.lineTo(zx + zw, zy + zh / 2); ctx.stroke();
      ctx.setLineDash([]);
    } else if (k === 'e') {
      ctx.fillStyle = 'rgba(41,98,255,0.15)'; ctx.strokeStyle = '#2962ff'; ctx.lineWidth = 2; ctx.setLineDash([]);
      ctx.beginPath();
      ctx.ellipse((g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2, Math.abs(g.x2 - g.x1) / 2, Math.abs(g.y2 - g.y1) / 2, 0, 0, 6.2832);
      ctx.fill(); ctx.stroke();
    } else if (k === 'f') {
      var fx1 = Math.min(g.x1, g.x2), fx2 = Math.max(g.x1, g.x2);
      linea(g.x1, g.y1, g.x2, g.y2, 'rgba(154,160,173,0.6)', 1);
      NIVELES_FIB.forEach(function (nv) {
        var p = d.b.p + (d.a.p - d.b.p) * nv[0];
        var y = serie.priceToCoordinate(p);
        if (y === null) return;
        linea(fx1, y, fx2, y, nv[1], 1);
        etiqueta(nv[0] + ' (' + fmt(p) + ')', fx1 + 4, y - 3, nv[1]);
      });
    } else if (k === 'long' || k === 'short') {
      var ls = posLS(d);
      var yTP = serie.priceToCoordinate(ls.tp), ySL = serie.priceToCoordinate(ls.sl);
      if (yTP === null || ySL === null) return;
      var px1 = Math.min(g.x1, g.x2), pw = Math.max(Math.abs(g.x2 - g.x1), 24);
      ctx.setLineDash([]);
      ctx.fillStyle = VERDE; ctx.fillRect(px1, Math.min(g.y1, yTP), pw, Math.abs(yTP - g.y1));
      ctx.fillStyle = ROJO; ctx.fillRect(px1, Math.min(g.y1, ySL), pw, Math.abs(ySL - g.y1));
      linea(px1, g.y1, px1 + pw, g.y1, 'rgba(232,235,242,0.9)', 1);
      etiqueta('Objetivo ' + fmt(ls.tp), px1 + 4, yTP + (yTP < g.y1 ? 12 : -4), '#b9f6ea');
      etiqueta('Stop ' + fmt(ls.sl), px1 + 4, ySL + (ySL < g.y1 ? 12 : -4), '#ffc9c9');
      etiqueta((k === 'long' ? 'COMPRA' : 'VENTA') + '  R:R ' + RR.toFixed(2), px1 + 4, g.y1 + (yTP < g.y1 ? 13 : -5), '#ffffff');
    } else if (k === 'm') {
      var sube = d.b.p >= d.a.p;
      var mx = Math.min(g.x1, g.x2), my = Math.min(g.y1, g.y2), mw = Math.abs(g.x2 - g.x1), mh = Math.abs(g.y2 - g.y1);
      ctx.fillStyle = sube ? 'rgba(41,98,255,0.18)' : 'rgba(239,83,80,0.18)'; ctx.fillRect(mx, my, mw, mh);
      ctx.strokeStyle = sube ? '#2962ff' : '#ef4444'; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.strokeRect(mx, my, mw, mh);
      var dif = d.b.p - d.a.p, pct = d.a.p ? (dif / d.a.p) * 100 : 0, barras = Math.round(Math.abs(d.b.t - d.a.t) / tfSeg);
      var tm = (dif >= 0 ? '+' : '') + fmt(dif) + ' (' + pct.toFixed(2) + '%) · ' + barras + ' velas';
      ctx.font = 'bold 12px sans-serif';
      var tw = ctx.measureText(tm).width + 12;
      ctx.fillStyle = sube ? '#2962ff' : '#ef4444';
      ctx.fillRect(mx + mw / 2 - tw / 2, my + mh / 2 - 10, tw, 20);
      ctx.fillStyle = '#fff'; ctx.fillText(tm, mx + mw / 2 - tw / 2 + 6, my + mh / 2 + 4);
    } else if (k === 'tx') {
      ctx.font = 'bold 14px sans-serif'; ctx.fillStyle = '#e8ebf2';
      ctx.fillText(d.s || '', g.x1, g.y1);
    } else if (k === 'p') {
      ctx.strokeStyle = '#f0b90b'; ctx.lineWidth = 2; ctx.setLineDash([]);
      ctx.beginPath();
      var primero = true;
      (d.pts || []).forEach(function (q) {
        var x = xDeTiempo(q.t), y = serie.priceToCoordinate(q.p);
        if (x === null || y === null) { primero = true; return; }
        if (primero) { ctx.moveTo(x, y); primero = false; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  function dibujar() {
    var w = cont.clientWidth, h = cont.clientHeight;
    ctx.clearRect(0, 0, w, h);
    pintarCuenta();
    dibujarBot(w);
    dibujarLentes(w);
    dibujarOps(w);
    if (!visibles) return;
    var lista = dib.slice();
    if (enCurso) lista.push(enCurso);
    lista.forEach(function (d) { dibujarUno(d, w, h); });
  }
  (function bucle() { dibujar(); requestAnimationFrame(bucle); })();

  // ---------- Barra de herramientas ----------
  var UNA_VEZ = { h: 1, v: 1, r: 1, tx: 1 };   // se colocan con un solo clic
  function ponerHerramienta(h) {
    herr = h;
    var bs = document.querySelectorAll('#barra button[data-h], #flot button[data-h]');
    for (var i = 0; i < bs.length; i++) bs[i].className = bs[i].getAttribute('data-h') === h ? 'on' : '';
    ov.style.pointerEvents = h === 'cursor' ? 'none' : 'auto';
    ov.style.cursor = h === 'cursor' ? 'default' : (h === 'x' ? 'not-allowed' : 'crosshair');
  }
  (function () {
    var bs = document.querySelectorAll('#barra button[data-h], #flot button[data-h]');
    for (var i = 0; i < bs.length; i++) bs[i].addEventListener('click', function (e) {
      ponerHerramienta(e.currentTarget.getAttribute('data-h'));
    });
  })();
  document.getElementById('b-undo').addEventListener('click', function () { dib.pop(); guardarDib(); });
  document.getElementById('b-clear').addEventListener('click', function () { dib = []; guardarDib(); });
  document.getElementById('b-ver').addEventListener('click', function () { visibles = !visibles; });
  document.getElementById('b-ops').addEventListener('click', function () { cfg.verOps = !cfg.verOps; guardarCfg(); pintarMenu(); reaplicarOps(); ocultarChip(); });

  ov.addEventListener('pointerdown', function (e) {
    if (herr === 'cursor') return;
    if (herr === 'x') {
      var r = cont.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      for (var i = dib.length - 1; i >= 0; i--) {
        if (golpe(dib[i], mx, my)) { dib.splice(i, 1); guardarDib(); break; }
      }
      return;
    }
    var pt = punto(e); if (!pt) return;
    if (UNA_VEZ[herr]) {
      var nuevo = { k: herr, a: pt, b: pt };
      if (herr === 'tx') {
        var s = '';
        try { s = window.prompt('Texto:', '') || ''; } catch (x) { s = ''; }
        if (!s) { ponerHerramienta('cursor'); return; }
        nuevo.s = s;
      }
      dib.push(nuevo); guardarDib(); ponerHerramienta('cursor');
      return;
    }
    try { ov.setPointerCapture(e.pointerId); } catch (x2) {}
    enCurso = { k: herr, a: pt, b: pt };
    if (herr === 'p') enCurso.pts = [pt];
  });
  ov.addEventListener('pointermove', function (e) {
    if (!enCurso) return;
    var pt = punto(e); if (!pt) return;
    enCurso.b = pt;
    if (enCurso.k === 'p' && enCurso.pts.length < 3000) enCurso.pts.push(pt);
  });
  ov.addEventListener('pointerup', function () {
    if (!enCurso) return;
    var d = enCurso; enCurso = null;
    var movio = d.a.t !== d.b.t || d.a.p !== d.b.p;
    if (d.k === 'long' || d.k === 'short') movio = d.a.p !== d.b.p;
    if (d.k === 'p') movio = d.pts.length > 2;
    if (movio) { dib.push(d); guardarDib(); }
    ponerHerramienta('cursor');
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { enCurso = null; ponerHerramienta('cursor'); }
  });

  // ---------- Datos desde la app ----------
  function cargar(m) {
    var sim = normalizarSimboloWeb(m.simbolo);
    var cambio = sim !== simbolo || m.tfSeg !== tfSeg;
    var otroSimbolo = sim !== simbolo;
    simbolo = sim; tfSeg = m.tfSeg;
    var v = m.velas || [];
    datos = v.slice();
    serie.setData(v);
    ultima = v.length ? { time: v[v.length - 1].time, open: v[v.length - 1].open, high: v[v.length - 1].high, low: v[v.length - 1].low, close: v[v.length - 1].close } : null;
    if (otroSimbolo) cargarAlertas();
    ultimoPrecioAlerta = ultima ? ultima.close : null;
    if (ultima) {
      var dec = precision(ultima.close);
      serie.applyOptions({ priceFormat: { type: 'price', precision: dec, minMove: 1 / Math.pow(10, dec) } });
    }
    elSim.textContent = simbolo + ' \\u00b7 ' + (m.tf || '');
    if (cambio || !m.conservarVista) verRecientes();   // ~120 velas con cuerpo visible, no las 800 apretadas
    hover = null; pintarOHLC(ultima); posFlot();
    if (otroSimbolo) { cargarDib(); opsRaw = []; aplicarNiveles(); botRaw = []; aplicarBot(); }
    aplicarMarcas();
    bid = null; ask = null; ultimoTickMs = 0;
    pintarPrecios();
    suscribir();
  }

  // ---------- Modo replay (backtest): mismo grafico, sin WebSocket ----------
  var REP = { velas: [], ops: [], idx: 0 };
  if (REPLAY) { var lpx = document.getElementById('lg-px'); if (lpx) lpx.style.display = 'none'; }
  function copiaVela(v) { return { time: v.time, open: v.open, high: v.high, low: v.low, close: v.close }; }
  // Operaciones del backtest vistas "hasta la vela actual": abiertas mientras no se cierran.
  function opsReplay() {
    var tNow = REP.idx > 0 ? REP.velas[REP.idx - 1].time : -1;
    var out = [];
    REP.ops.forEach(function (o) {
      if (Math.floor(o.tA / tfSeg) * tfSeg > tNow) return;
      var cerrada = o.tC !== null && o.tC !== undefined && Math.floor(o.tC / tfSeg) * tfSeg <= tNow;
      if (cerrada) { out.push(o); return; }
      var flotante = (ultima && typeof o.vol === 'number' && typeof o.valorUnidad === 'number')
        ? (ultima.close - o.entrada) * (o.lado === 'compra' ? 1 : -1) * o.vol * o.valorUnidad
        : null;
      out.push({
        id: o.id, lado: o.lado, estado: 'en_curso', tA: o.tA, tC: null,
        entrada: o.entrada, sl: o.sl, tp: o.tp, cierre: null, profit: flotante,
        res: flotante === null ? '' : (flotante >= 0 ? 'ganada' : 'perdida'), vol: o.vol,
      });
    });
    return out;
  }
  function ponerIndice(n, forzar) {
    n = Math.max(0, Math.min(REP.velas.length, Math.round(Number(n) || 0)));
    var prev = REP.idx;
    REP.idx = n;
    if (!forzar && n === prev) return;
    if (!forzar && n > prev && datos.length === prev) {
      for (var i = prev; i < n; i++) { var v = copiaVela(REP.velas[i]); datos.push(v); serie.update(v); }
    } else {
      datos = REP.velas.slice(0, n).map(copiaVela);
      serie.setData(datos);
    }
    ultima = datos.length ? copiaVela(datos[datos.length - 1]) : null;
    if (forzar || n < prev) ultimoPrecioAlerta = null;
    evaluarAlertas(ultima ? ultima.close : null);
    bid = ultima ? ultima.close : null; ask = bid;
    opsRaw = opsReplay();
    aplicarMarcas(); aplicarNiveles(); pintarPrecios();
    if (!hover) pintarOHLC(ultima);
    pintarReloj();
  }
  function cargarReplay(m) {
    simbolo = normalizarSimboloWeb(m.simbolo); tfSeg = m.tfSeg || 60;
    offsetSeg = 0; offsetListo = true;   // las velas y las horas del backtest ya van en la misma escala
    REP.velas = m.velas || []; REP.ops = m.ops || [];
    aplicarLentesReplay(m);
    cargarDib();
    cargarAlertas();
    var ref = REP.velas.length ? REP.velas[Math.min(Math.max(m.indice || 1, 1), REP.velas.length) - 1] : null;
    if (ref) {
      var dec = precision(ref.close);
      serie.applyOptions({ priceFormat: { type: 'price', precision: dec, minMove: 1 / Math.pow(10, dec) } });
    }
    elSim.textContent = simbolo + ' · ' + (m.tf || '');
    hover = null;
    ponerIndice(m.indice, true);
    if (!m.conservarVista) verRecientes();
    posFlot();
  }

  function aplicarLentesReplay(m) {
    lentesRaw = Array.isArray(m.lentes) ? m.lentes.map(function (l, i) {
      return Object.assign({}, l, { color: coloresLentes[l.nombre] || COLORES_LENTE[i % COLORES_LENTE.length] });
    }) : [];
    zonasLentesRaw = Array.isArray(m.zonas) ? m.zonas : [];
    temporalidadesFaltantes = Array.isArray(m.temporalidades_faltantes) ? m.temporalidades_faltantes : [];
    pintarLentesLista();
  }

  function recibir(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'cargar') cargar(m);
    else if (m.type === 'replay') cargarReplay(m);
    else if (m.type === 'indice') ponerIndice(m.indice, false);
    else if (m.type === 'ops') {
      opsRaw = m.ops || [];
      aplicarMarcas(); aplicarNiveles();
    }
    else if (m.type === 'bot') {
      botRaw = Array.isArray(m.escenarios) ? m.escenarios : [];
      aplicarBot();
    }
    else if (m.type === 'lentes') {
      aplicarLentesReplay(m);
      aplicarBot();
    }
  }
  window.__rn = recibir;   // WebView nativo (injectJavaScript)
  window.addEventListener('message', function (e) {   // iframe en web
    if (e.source !== window.parent) return;
    recibir(e.data);
  });

  // Estado y precio hacia la app (máx. ~2 veces por segundo, no en cada tick).
  setInterval(function () {
    if (REPLAY) { elLiveT.textContent = 'Replay'; elLive.className = 'off'; return; }
    var est = 'conectando';
    if (sinAuth) est = 'auth';
    else if (!abierto) est = huboConexion ? 'reconectando' : 'conectando';
    else if (ultimoTickMs && Date.now() - ultimoTickMs < 15000) est = 'vivo';
    else est = ultimoTickMs ? 'sin_ticks' : 'conectando';
    var px = bid === null ? '' : bid + '|' + ask;
    var etq = { conectando: 'Conectando', vivo: 'En vivo', sin_ticks: 'Sin ticks', reconectando: 'Reconectando', auth: 'Clave rechazada' };
    elLiveT.textContent = etq[est];
    elLive.className = est === 'vivo' ? '' : 'off';
    if (est !== estadoEnviado || px !== pxEnviado) {
      estadoEnviado = est; pxEnviado = px;
      enviar({ type: 'estado', estado: est, bid: bid, ask: ask });
    }
  }, 500);

  if (!REPLAY) conectar();
  enviar({ type: 'listo' });
})();
</script>
</body></html>`;
}

export function GraficoVivo({ apiUrl, apiKey, simboloInicial }: { apiUrl: string; apiKey: string; simboloInicial?: string }) {
  const inicial = (simboloInicial || '').trim() || 'XAUUSD';
  const esWeb = Platform.OS === 'web';
  const [simbolo, setSimbolo] = useState(inicial);
  const [entrada, setEntrada] = useState(inicial);
  const [tf, setTf] = useState<string>('M1');
  const [listo, setListo] = useState(false);
  const [estado, setEstado] = useState<EstadoVivo>('conectando');
  const [px, setPx] = useState<{ bid: number; ask: number } | null>(null);
  const [ticketOrden, setTicketOrden] = useState<{ tipo: 'compra' | 'venta'; simbolo: string; bid: number; ask: number } | null>(null);
  const [tipoOrdenTicket, setTipoOrdenTicket] = useState<'mercado' | 'limite'>('mercado');
  const [volumenTicket, setVolumenTicket] = useState('');
  const [entradaTicket, setEntradaTicket] = useState('');
  const [slTicket, setSlTicket] = useState('');
  const [tpTicket, setTpTicket] = useState('');
  const [enviandoTicket, setEnviandoTicket] = useState(false);
  const [resultadoTicket, setResultadoTicket] = useState('');
  const [error, setError] = useState('');
  const [errorLentes, setErrorLentes] = useState('');
  const [recarga, setRecarga] = useState(0);
  const [ampliado, setAmpliado] = useState(false);
  const [verBot, setVerBot] = useState(true);
  const [nBot, setNBot] = useState(0);        // escenarios del bot en este símbolo; -1 = escáner apagado
  const conservarVistaRef = useRef(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cajaRef = useRef<unknown>(null);
  const webviewRef = useRef<WebView>(null);

  // En desarrollo local apiUrl llega vacío (el proxy de Vite reenvía /api y /ws/vivo).
  // Dentro del iframe (about:srcdoc) una URL relativa NO sirve, así que se arma absoluta aquí.
  const wsUrl = useMemo(() => {
    const base = (apiUrl || '').trim().replace(/\/+$/, '');
    if (base) return `${base.replace(/^http/i, 'ws')}/ws/vivo`;
    if (typeof window !== 'undefined' && window.location?.host) {
      return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/vivo`;
    }
    return '/ws/vivo';
  }, [apiUrl]);
  // Estable: si cambiara, el iframe/WebView se recargaría y se perdería el gráfico.
  const html = useMemo(() => construirHtmlVivo(wsUrl, apiKey), [wsUrl, apiKey]);

  const alGrafico = useCallback((msg: unknown) => {
    if (Platform.OS === 'web') iframeRef.current?.contentWindow?.postMessage(msg, '*');
    else webviewRef.current?.injectJavaScript(`window.__rn(${JSON.stringify(msg)}); true;`);
  }, []);

  const manejar = useCallback((msg: { type?: string; estado?: EstadoVivo; bid?: number | null; ask?: number | null; tipo?: string; simbolo?: string }) => {
    if (msg.type === 'listo') setListo(true);
    else if (msg.type === 'estado' && msg.estado) {
      setEstado(msg.estado);
      setPx(typeof msg.bid === 'number' && typeof msg.ask === 'number' ? { bid: msg.bid, ask: msg.ask } : null);
    } else if (msg.type === 'orden_solicitada' && (msg.tipo === 'compra' || msg.tipo === 'venta') &&
        typeof msg.simbolo === 'string' && typeof msg.bid === 'number' && typeof msg.ask === 'number') {
      setTicketOrden({ tipo: msg.tipo, simbolo: msg.simbolo, bid: msg.bid, ask: msg.ask });
      setTipoOrdenTicket('mercado');
      setVolumenTicket('');
      setEntradaTicket('');
      setSlTicket('');
      setTpTicket('');
      setResultadoTicket('');
    } else if (msg.type === 'reconectado') {
      conservarVistaRef.current = true;
      setRecarga((n) => n + 1);
    }
  }, []);

  async function enviarOrdenTicket(datos: {
    tipo: 'compra' | 'venta';
    simbolo: string;
    volumen: number;
    sl: number;
    tp: number;
    tipo_orden: 'mercado' | 'limite';
    precio_entrada: number;
  }) {
    setEnviandoTicket(true);
    setResultadoTicket('');
    try {
      const respuesta = await fetch(`${apiUrl}/api/orden/grafico`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(datos),
      });
      const cuerpo: unknown = await respuesta.json();
      if (!respuesta.ok) {
        const detalle = cuerpo && typeof cuerpo === 'object' && 'detail' in cuerpo
          ? (cuerpo as { detail?: unknown }).detail
          : null;
        throw new Error(typeof detalle === 'string' ? detalle : `El servidor rechazó la orden (${respuesta.status}).`);
      }
      const parsed = OrdenManualRespSchema.safeParse(cuerpo);
      if (!parsed.success) throw new Error('Respuesta inesperada al enviar la orden.');
      if (!parsed.data.ok) {
        setResultadoTicket(parsed.data.error || 'MT5 rechazó la orden; no se confirmó su ejecución.');
        return;
      }
      const ticket = parsed.data.ticket ? ` · Ticket ${parsed.data.ticket}` : '';
      setResultadoTicket(`Orden aceptada por MT5${ticket}.`);
      setRecarga((n) => n + 1);
    } catch (e) {
      setResultadoTicket(e instanceof Error ? e.message : 'No se pudo enviar la orden.');
    } finally {
      setEnviandoTicket(false);
    }
  }

  function confirmarOrdenTicket() {
    if (!ticketOrden || enviandoTicket || resultadoTicket.startsWith('Orden aceptada')) return;
    if (estado !== 'vivo' || !px) {
      setResultadoTicket('MT5 no tiene cotización en vivo; la orden no se envió.');
      return;
    }
    const volumen = Number(volumenTicket);
    if (!Number.isFinite(volumen) || volumen <= 0) {
      setResultadoTicket('Indica un volumen manual mayor que cero.');
      return;
    }
    const entrada = tipoOrdenTicket === 'limite' ? Number(entradaTicket) : 0;
    if (tipoOrdenTicket === 'limite') {
      if (!Number.isFinite(entrada) || entrada <= 0) {
        setResultadoTicket('Indica un precio de entrada válido para la orden límite.');
        return;
      }
      const precioActual = ticketOrden.tipo === 'compra' ? ticketOrden.ask : ticketOrden.bid;
      if ((ticketOrden.tipo === 'compra' && entrada >= precioActual) ||
          (ticketOrden.tipo === 'venta' && entrada <= precioActual)) {
        setResultadoTicket(ticketOrden.tipo === 'compra'
          ? 'Una compra límite debe quedar por debajo del Ask actual.'
          : 'Una venta límite debe quedar por encima del Bid actual.');
        return;
      }
    }
    const sl = slTicket.trim() ? Number(slTicket) : 0;
    const tp = tpTicket.trim() ? Number(tpTicket) : 0;
    if (!Number.isFinite(sl) || sl < 0 || !Number.isFinite(tp) || tp < 0) {
      setResultadoTicket('SL y TP deben ser precios positivos o quedar vacíos.');
      return;
    }
    const datos = {
      tipo: ticketOrden.tipo,
      simbolo: ticketOrden.simbolo,
      volumen,
      sl,
      tp,
      tipo_orden: tipoOrdenTicket,
      precio_entrada: entrada,
    };
    const lado = ticketOrden.tipo === 'compra' ? 'COMPRA' : 'VENTA';
    const clase = tipoOrdenTicket === 'mercado' ? 'Mercado' : `Límite a ${entrada}`;
    const texto = `${lado} ${ticketOrden.simbolo} · ${volumen} lotes\nTipo: ${clase}\nSL: ${sl || 'sin SL'} · TP: ${tp || 'sin TP'}\n\n¿Enviar la orden a MetaTrader 5?`;
    const ejecutar = () => { void enviarOrdenTicket(datos); };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`Confirmar operación\n\n${texto}`)) ejecutar();
      return;
    }
    Alert.alert('Confirmar operación', texto, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Enviar', style: ticketOrden.tipo === 'venta' ? 'destructive' : 'default', onPress: ejecutar },
    ]);
  }

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const alMensaje = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data && typeof event.data === 'object') manejar(event.data);
    };
    window.addEventListener('message', alMensaje);
    return () => window.removeEventListener('message', alMensaje);
  }, [manejar]);

  // Ampliar: en web se usa la pantalla completa del navegador sobre la caja del gráfico. Así
  // queda fuera del ScrollView de la app (que recorta cualquier "position: fixed") y el iframe
  // no se recrea. Si el navegador no la permite, queda el modo "fijo" de respaldo.
  const alternarAmpliado = useCallback(() => {
    if (!esWeb) { setAmpliado((a) => !a); return; }
    const el = cajaRef.current as HTMLElement | null;
    if (!ampliado) {
      setAmpliado(true);
      if (el && typeof el.requestFullscreen === 'function') el.requestFullscreen().catch(() => { /* respaldo: modo fijo */ });
    } else {
      setAmpliado(false);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => { /* ya salió */ });
    }
  }, [esWeb, ampliado]);

  useEffect(() => {
    if (!esWeb) return;
    // Esc (o salir desde el navegador) cierra la pantalla completa: se sincroniza el estado.
    const alCambiar = () => { if (!document.fullscreenElement) setAmpliado(false); };
    document.addEventListener('fullscreenchange', alCambiar);
    return () => document.removeEventListener('fullscreenchange', alCambiar);
  }, [esWeb]);

  // Respaldo (sin pantalla completa del navegador): Esc cierra el modo fijo.
  useEffect(() => {
    if (!esWeb || !ampliado) return;
    const alTeclado = (e: KeyboardEvent) => { if (e.key === 'Escape') setAmpliado(false); };
    window.addEventListener('keydown', alTeclado);
    return () => window.removeEventListener('keydown', alTeclado);
  }, [esWeb, ampliado]);

  // Carga el histórico (y lo vuelve a cargar si cambia símbolo/temporalidad o se reconecta).
  useEffect(() => {
    if (!listo) return;
    let cancelado = false;
    const conservarVista = conservarVistaRef.current;
    conservarVistaRef.current = false;
    (async () => {
      try {
        setError('');
        const sim = normalizarSimbolo(simbolo);
        const url = `${apiUrl}/api/vivo/velas?simbolo=${encodeURIComponent(sim)}&timeframe=${tf}&cantidad=${CANTIDAD_VELAS}`;
        const resp = await fetch(url, { headers: { 'X-API-Key': apiKey } });
        if (!resp.ok) throw new Error(`Servidor: ${resp.status}`);
        const parsed = VelasRespSchema.safeParse(await resp.json());
        if (!parsed.success) throw new Error('Respuesta inesperada de /api/vivo/velas. Reinicia el backend.');
        if ('error' in parsed.data) throw new Error(parsed.data.error);
        if (cancelado) return;
        alGrafico({ type: 'cargar', simbolo, tf, tfSeg: TF_SEG[tf], velas: parsed.data.velas, conservarVista });
      } catch (e) {
        if (!cancelado) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelado = true; };
  }, [listo, simbolo, tf, recarga, apiUrl, apiKey, alGrafico]);

  // Operaciones del diario (cerradas y en curso): cajas, flechas y líneas SL/TP.
  useEffect(() => {
    if (!listo) return;
    let cancelado = false;
    const traer = async () => {
      try {
        const sim = normalizarSimbolo(simbolo);
        const [posResp, diarioResp] = await Promise.all([
          fetch(`${apiUrl}/api/posiciones`, { headers: { 'X-API-Key': apiKey } }),
          fetch(`${apiUrl}/api/diario`, { headers: { 'X-API-Key': apiKey } }),
        ]);
        const ops: Op[] = [];
        const vistos = new Set<number>();

        if (posResp.ok) {
          const parsed = z.array(PosicionAbiertaSchema).safeParse(await posResp.json());
          if (parsed.success) {
            for (const p of parsed.data) {
              if (normalizarSimbolo(p.simbolo) !== sim) continue;
              if (typeof p.precio_apertura !== 'number' || typeof p.hora_apertura !== 'number') continue;
              const id = typeof p.ticket === 'number' ? p.ticket : Math.abs(Math.round(p.precio_apertura * 1000000));
              vistos.add(id);
              ops.push({
                id,
                lado: p.tipo === 'venta' ? 'venta' : 'compra',
                estado: 'en_curso',
                tA: p.hora_apertura,
                tC: null,
                entrada: precioValido(p.precio_apertura) ?? 0,
                sl: precioValido(p.sl),
                tp: precioValido(p.tp),
                cierre: null,
                profit: typeof p.profit === 'number' ? p.profit : null,
                res: '',
                vol: typeof p.volumen === 'number' ? p.volumen : null,
              });
            }
          }
        }

        if (diarioResp.ok) {
          const parsed = z.array(FichaSchema.passthrough()).safeParse(await diarioResp.json());
          if (parsed.success) {
            for (const f of parsed.data) {
              if (normalizarSimbolo(f.simbolo) !== sim) continue;
              if (typeof f.entrada !== 'number' || typeof f.hora_apertura !== 'number') continue;
              const id = typeof f.id === 'number' ? f.id : Math.abs(Math.round(f.entrada * 1000000 + f.hora_apertura));
              if (vistos.has(id)) continue;
              ops.push({
                id,
                lado: f.tipo === 'venta' ? 'venta' : 'compra',
                estado: f.estado,
                tA: f.hora_apertura,
                tC: f.estado === 'en_curso' ? null : (typeof f.hora_cierre === 'number' ? f.hora_cierre : null),
                entrada: precioValido(f.entrada) ?? 0,
                sl: precioValido(f.sl),
                tp: precioValido(f.tp),
                cierre: precioValido(f.precio_cierre),
                profit: typeof f.profit === 'number' ? f.profit : null,
                res: f.resultado || '',
                vol: typeof f.volumen === 'number' ? f.volumen : null,
              });
            }
          }
        }

        if (!cancelado) alGrafico({ type: 'ops', ops });
      } catch { /* sin posiciones/diario no pasa nada: el gráfico sigue igual */ }
    };
    traer();
    const id = setInterval(traer, REFRESCO_OPS_MS);
    return () => { cancelado = true; clearInterval(id); };
  }, [listo, simbolo, tf, recarga, apiUrl, apiKey, alGrafico]);

  // Lo que el bot detecta (zonas, niveles, motivos). Solo lee: no cambia ninguna decisión.
  useEffect(() => {
    if (!listo) return;
    let cancelado = false;
    if (!verBot) { alGrafico({ type: 'bot', escenarios: [] }); return; }
    const traer = async () => {
      try {
        const resp = await fetch(`${apiUrl}/api/vivo/analisis?simbolo=${encodeURIComponent(normalizarSimbolo(simbolo))}`, { headers: { 'X-API-Key': apiKey } });
        if (!resp.ok) return;
        const d: unknown = await resp.json();
        const o = (d && typeof d === 'object' ? d : {}) as { corriendo?: boolean; escenarios?: unknown };
        const esc = o.corriendo && Array.isArray(o.escenarios) ? o.escenarios : [];
        if (cancelado) return;
        setNBot(o.corriendo ? esc.length : -1);
        alGrafico({ type: 'bot', escenarios: esc });
      } catch { /* sin análisis el gráfico sigue igual */ }
    };
    traer();
    const id = setInterval(traer, REFRESCO_BOT_MS);
    return () => { cancelado = true; clearInterval(id); };
  }, [listo, simbolo, verBot, recarga, apiUrl, apiKey, alGrafico]);

  useEffect(() => {
    if (!listo) return;
    let cancelado = false;
    const traer = async () => {
      try {
        const resp = await fetch(`${apiUrl}/api/vivo/lentes?simbolo=${encodeURIComponent(normalizarSimbolo(simbolo))}`, { headers: { 'X-API-Key': apiKey } });
        if (!resp.ok) throw new Error(`Servidor de temporalidades: ${resp.status}`);
        const parsed = LentesVivoSchema.safeParse(await resp.json());
        if (!parsed.success) throw new Error('Respuesta inesperada al cargar la estructura de temporalidades.');
        if (cancelado) return;
        setErrorLentes('');
        alGrafico({ type: 'lentes', ...parsed.data });
      } catch (e) {
        if (!cancelado) setErrorLentes(e instanceof Error ? e.message : String(e));
      }
    };
    traer();
    const id = setInterval(traer, 60000);
    return () => { cancelado = true; clearInterval(id); };
  }, [listo, simbolo, recarga, apiUrl, apiKey, alGrafico]);

  const cambiarSimbolo = () => {
    const limpio = normalizarSimbolo(entrada);   // MT5 distingue mayúsculas: eurusd -> EURUSD
    if (limpio !== entrada) setEntrada(limpio);
    if (limpio && limpio !== normalizarSimbolo(simbolo)) setSimbolo(limpio);
  };

  const dec = px ? (px.bid > 500 ? 2 : px.bid > 50 ? 3 : 5) : 2;
  const etiqueta = ETIQUETA[estado];

  // Pantalla completa: en web la caja entera se fija sobre toda la ventana (el iframe NO se
  // recrea, solo cambia su estilo, así no se pierde el gráfico). En móvil solo crece el alto.
  const estiloCaja = ampliado && esWeb
    ? ({ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 9999, margin: 0, borderRadius: 0, borderWidth: 0, boxSizing: 'border-box', overflow: 'hidden' } as never)
    : null;
  const estiloGrafico = ampliado && esWeb
    ? s.graficoLleno
    : esWeb
      ? [s.graficoWeb, ({ height: 'calc(100dvh - 200px)', minHeight: 340 } as never)]
      : s.grafico;

  return (
    <View ref={cajaRef as never} style={[s.caja, estiloCaja]}>
      <View style={s.fila}>
        <TextInput
          style={s.input}
          value={entrada}
          onChangeText={(t) => setEntrada(t.toUpperCase())}
          onSubmitEditing={cambiarSimbolo}
          onBlur={cambiarSimbolo}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="XAUUSD"
          placeholderTextColor="#596572"
        />
        <View style={[s.pastilla, { borderColor: etiqueta.color }]}>
          <View style={[s.punto, { backgroundColor: etiqueta.color }]} />
          <Text style={[s.pastillaTexto, { color: etiqueta.color }]}>{etiqueta.texto}</Text>
        </View>
        {px ? (
          <Text style={s.precioInline}>
            Bid {px.bid.toFixed(dec)}  ·  Ask {px.ask.toFixed(dec)}  ·  Spread {(px.ask - px.bid).toFixed(dec)}
          </Text>
        ) : null}
        <Pressable onPress={() => setVerBot((v) => !v)} style={s.ampliar}>
          <Text style={s.ampliarTexto}>{!verBot ? 'Bot: oculto' : nBot < 0 ? 'Bot: escáner apagado' : `Bot: ${nBot} zona${nBot === 1 ? '' : 's'}`}</Text>
        </Pressable>
        <Pressable onPress={alternarAmpliado} style={s.ampliar}>
          <Text style={s.ampliarTexto}>{ampliado ? '✕ Salir' : '⤢ Ampliar'}</Text>
        </Pressable>
      </View>
      <View style={s.fila}>
        {TFS.map((t) => (
          <Pressable key={t} onPress={() => setTf(t)} style={[s.tf, tf === t && s.tfActivo]}>
            <Text style={[s.tfTexto, tf === t && s.tfTextoActivo]}>{t}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {errorLentes ? <Text style={s.error}>{errorLentes}</Text> : null}
      <View style={estiloGrafico}>
        {Platform.OS === 'web'
          ? createElement('iframe', {
              ref: iframeRef,
              srcDoc: html,
              title: 'Gráfico en vivo',
              // Absoluto: llena siempre su caja, sin depender de que el flex calcule la altura.
              style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none', backgroundColor: '#0a1118' },
            })
          : <WebView
              ref={webviewRef}
              originWhitelist={['*']}
              source={{ html }}
              style={{ flex: 1, backgroundColor: '#0a1118' }}
              javaScriptEnabled
              domStorageEnabled
              nestedScrollEnabled
              mixedContentMode="always"
              onMessage={(event) => {
                try { manejar(JSON.parse(event.nativeEvent.data)); } catch { /* mensaje ajeno al gráfico */ }
              }}
            />}
      </View>
      <Modal visible={ticketOrden !== null} transparent animationType="fade" onRequestClose={() => setTicketOrden(null)}>
        <View style={s.ticketFondo}>
            <View style={s.ticketPanel}>
              <ScrollView style={s.ticketScroll} contentContainerStyle={s.ticketContenido} keyboardShouldPersistTaps="handled">
                <Text style={s.ticketTitulo}>{ticketOrden?.tipo === 'venta' ? 'Vender' : 'Comprar'} · {ticketOrden?.simbolo}</Text>
                <Text style={s.ticketPrecio}>Bid {ticketOrden?.bid.toFixed(dec)} · Ask {ticketOrden?.ask.toFixed(dec)}</Text>
                <Text style={s.ticketEtiqueta}>TIPO DE ORDEN</Text>
                <View style={s.ticketFila}>
                  {(['mercado', 'limite'] as const).map((tipo) => (
                    <Pressable key={tipo} onPress={() => { setTipoOrdenTicket(tipo); setResultadoTicket(''); }} style={[s.ticketOpcion, tipoOrdenTicket === tipo && s.ticketOpcionActiva]}>
                      <Text style={[s.ticketOpcionTexto, tipoOrdenTicket === tipo && s.ticketOpcionTextoActiva]}>{tipo === 'mercado' ? 'Mercado' : 'Límite'}</Text>
                    </Pressable>
                  ))}
                </View>
                {tipoOrdenTicket === 'limite' ? (
                  <TextInput style={s.ticketInput} value={entradaTicket} onChangeText={setEntradaTicket} placeholder="Precio de entrada" placeholderTextColor="#71808c" keyboardType="decimal-pad" />
                ) : null}
                <TextInput style={s.ticketInput} value={volumenTicket} onChangeText={setVolumenTicket} placeholder="Volumen manual (lotes)" placeholderTextColor="#71808c" keyboardType="decimal-pad" />
                <View style={s.ticketFila}>
                  <TextInput style={[s.ticketInput, s.ticketMitad]} value={slTicket} onChangeText={setSlTicket} placeholder="Stop Loss (opcional)" placeholderTextColor="#71808c" keyboardType="decimal-pad" />
                  <TextInput style={[s.ticketInput, s.ticketMitad]} value={tpTicket} onChangeText={setTpTicket} placeholder="Take Profit (opcional)" placeholderTextColor="#71808c" keyboardType="decimal-pad" />
                </View>
                <Text style={s.ticketNota}>Sin SL, la operación queda sin stop loss. El envío requiere MT5 en vivo y confirmación.</Text>
                {resultadoTicket ? <Text style={s.ticketResultado}>{resultadoTicket}</Text> : null}
                <View style={s.ticketFila}>
                  <Pressable disabled={enviandoTicket} onPress={() => setTicketOrden(null)} style={s.ticketCancelar}>
                    <Text style={s.ticketCancelarTexto}>{resultadoTicket.startsWith('Orden aceptada') ? 'Cerrar' : 'Cancelar'}</Text>
                  </Pressable>
                  <Pressable disabled={enviandoTicket || estado !== 'vivo' || !px || resultadoTicket.startsWith('Orden aceptada')} onPress={confirmarOrdenTicket} style={[s.ticketEnviar, (enviandoTicket || estado !== 'vivo' || !px || resultadoTicket.startsWith('Orden aceptada')) && s.ticketDeshabilitado]}>
                    <Text style={s.ticketEnviarTexto}>{enviandoTicket ? 'Enviando…' : resultadoTicket.startsWith('Orden aceptada') ? 'Orden enviada' : estado !== 'vivo' || !px ? 'Esperando MT5…' : 'Revisar y enviar'}</Text>
                  </Pressable>
                </View>
              </ScrollView>
            </View>
        </View>
      </Modal>
    </View>
  );
}

// ---------- Replay del backtest con el MISMO diseño del gráfico en vivo ----------
// Reutiliza el HTML del gráfico (construirHtmlVivo en modo replay): mismas velas, barra de
// herramientas, dibujos, cajas de operación y flechas. No usa WebSocket: la app le dice
// cuántas velas mostrar y el gráfico las va destapando.
const TF_REPLAY = ['M1', 'M3', 'M5', 'M15', 'M30', 'H1', 'H2', 'H4', 'D1'] as const;
const TF_SEG_REPLAY: Record<string, number> = { M1: 60, M3: 180, M5: 300, M15: 900, M30: 1800, H1: 3600, H2: 7200, H4: 14400, D1: 86400, W1: 604800 };
const VELOCIDADES_REPLAY = [1, 2, 5, 10, 20, 50];

export type VelaReplayGv = { time: number; open: number; high: number; low: number; close: number };
export type LentesReplayGv = {
  lentes: {
    nombre: string;
    vista: string;
    estructura: string;
    direccion: string;
    direccion_vista: string;
    fase: string;
    pivotes: { time: number; confirmacion?: number; precio: number; tipo: 'high' | 'low'; clase: string }[];
    quiebres: { time: number; precio: number; direccion: string; tipo: 'BOS' | 'CHOCH' }[];
  }[];
  zonas: { estructura: string; tipo: string; direccion: string; estado: string; rango: [number, number] }[];
  temporalidades_faltantes: string[];
};
export type OperacionBacktestGv = {
  tipo: string;
  entrada: number;
  sl: number;
  tp: number;
  salida?: number | null;
  profit?: number | null;
  hora_apertura: string;
  hora_cierre?: string | null;
  volumen?: number;
  motivo_cierre?: string;
  be_aplicado?: boolean;
  riesgo_objetivo?: number;
  riesgo_real?: number;
  riesgo_actual?: number;
};

// "YYYY-MM-DD HH:MM:SS" ya viene en la misma escala que las velas: se lee como UTC a mano.
function epochBacktest(f: string): number {
  const [fecha, hora] = (f || '').split(' ');
  const [y, m, d] = (fecha || '').split('-').map(Number);
  const [hh, mm, ss] = (hora || '0:0:0').split(':').map(Number);
  return Math.floor(Date.UTC(y || 1970, (m || 1) - 1, d || 1, hh || 0, mm || 0, ss || 0) / 1000);
}

function velasHasta(datos: VelaReplayGv[], tiempo: number | null): number {
  if (tiempo === null) return 0;
  let bajo = 0;
  let alto = datos.length;
  while (bajo < alto) {
    const medio = Math.floor((bajo + alto) / 2);
    if (datos[medio].time <= tiempo) bajo = medio + 1;
    else alto = medio;
  }
  return bajo;
}

export function GraficoReplay({ velas, operaciones, posicionesAbiertas, valorPorUnidadLote, simbolo, desde, hasta, indiceInicio, timeframeBase, cargarVelas, cargarLentes, onClose }: {
  velas: VelaReplayGv[];
  operaciones: OperacionBacktestGv[];
  posicionesAbiertas: OperacionBacktestGv[];
  valorPorUnidadLote: number;
  simbolo: string;
  desde: string;
  hasta: string;
  indiceInicio?: number;
  timeframeBase?: string | null;
  cargarVelas: (timeframe: string) => Promise<VelaReplayGv[]>;
  cargarLentes: () => Promise<LentesReplayGv>;
  onClose: () => void;
}) {
  const esWeb = Platform.OS === 'web';
  const base = timeframeBase || 'M15';
  const inicio = Math.max(1, Math.min(indiceInicio ?? Math.min(50, velas.length), velas.length));
  const [serie, setSerie] = useState<{ tf: string; velas: VelaReplayGv[] }>({ tf: base, velas });
  const [tf, setTf] = useState<string>(base);
  const [indice, setIndice] = useState(inicio);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [velocidad, setVelocidad] = useState(1);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [errorLentes, setErrorLentes] = useState('');
  const [intentoLentes, setIntentoLentes] = useState(0);
  const [lentesReplay, setLentesReplay] = useState<LentesReplayGv>({
    lentes: [], zonas: [], temporalidades_faltantes: [],
  });
  const [listo, setListo] = useState(false);
  const [pestanaOps, setPestanaOps] = useState<'abiertas' | 'historial'>('historial');
  const [panelOpsAbierto, setPanelOpsAbierto] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<WebView>(null);
  const indiceRef = useRef(indice);
  indiceRef.current = indice;
  const tiempoRef = useRef<number | null>(velas[inicio - 1]?.time ?? null);
  const cargarRef = useRef(cargarVelas);
  cargarRef.current = cargarVelas;
  const cargarLentesRef = useRef(cargarLentes);
  cargarLentesRef.current = cargarLentes;
  const html = useMemo(() => construirHtmlVivo('', '', true), []);

  const ops = useMemo(() => {
    const riesgoDesdeSL = (o: OperacionBacktestGv): number | undefined => {
      if (typeof o.volumen !== 'number' || o.volumen <= 0) return undefined;
      const movimientoCierre = typeof o.salida === 'number' ? Math.abs(o.salida - o.entrada) : 0;
      const valorInferido = typeof o.profit === 'number' && movimientoCierre > 0
        ? Math.abs(o.profit) / (movimientoCierre * o.volumen)
        : 0;
      const valorUnidad = Number.isFinite(valorPorUnidadLote) && valorPorUnidadLote > 0
        ? valorPorUnidadLote
        : valorInferido;
      if (!Number.isFinite(valorUnidad) || valorUnidad <= 0) return undefined;
      const riesgo = Math.abs(o.entrada - o.sl) * o.volumen * valorUnidad;
      return Number.isFinite(riesgo) ? riesgo : undefined;
    };
    const riesgoInicial = (o: OperacionBacktestGv): number | undefined => {
      if (typeof o.riesgo_real === 'number' && Number.isFinite(o.riesgo_real) && o.riesgo_real > 0) return o.riesgo_real;
      return o.be_aplicado ? undefined : riesgoDesdeSL(o);
    };
    const riesgoConfigurado = (o: OperacionBacktestGv): number | undefined => (
      typeof o.riesgo_objetivo === 'number' && Number.isFinite(o.riesgo_objetivo) && o.riesgo_objetivo > 0
        ? o.riesgo_objetivo
        : undefined
    );

    return [
      ...operaciones.map((o, i) => ({
        id: i + 1,
        lado: o.tipo === 'venta' ? 'venta' : 'compra',
        estado: 'cerrada',
        tA: epochBacktest(o.hora_apertura),
        tC: o.hora_cierre ? epochBacktest(o.hora_cierre) : null,
        entrada: o.entrada,
        sl: o.sl,
        tp: o.tp,
        cierre: o.salida ?? null,
        profit: o.profit ?? null,
        res: (o.profit ?? 0) >= 0 ? 'ganada' : 'perdida',
        vol: typeof o.volumen === 'number' ? o.volumen : null,
        motivo: o.motivo_cierre ?? '',
        riesgoObjetivo: riesgoConfigurado(o),
        riesgoReal: riesgoInicial(o),
        riesgoActual: riesgoInicial(o),
        riesgoEstimado: !(typeof o.riesgo_real === 'number' && Number.isFinite(o.riesgo_real) && o.riesgo_real > 0),
        valorUnidad: valorPorUnidadLote,
      })),
      ...posicionesAbiertas.map((o, i) => ({
        id: operaciones.length + i + 1,
        lado: o.tipo === 'venta' ? 'venta' : 'compra',
        estado: 'en_curso',
        tA: epochBacktest(o.hora_apertura),
        tC: null,
        entrada: o.entrada,
        sl: o.sl,
        tp: o.tp,
        cierre: null,
        profit: null,
        res: '',
        vol: typeof o.volumen === 'number' ? o.volumen : null,
        motivo: '',
        riesgoObjetivo: riesgoConfigurado(o),
        riesgoReal: riesgoInicial(o),
        riesgoActual: typeof o.riesgo_actual === 'number' && Number.isFinite(o.riesgo_actual)
          ? o.riesgo_actual
          : riesgoDesdeSL(o),
        riesgoEstimado: !(typeof o.riesgo_real === 'number' && Number.isFinite(o.riesgo_real) && o.riesgo_real > 0),
        valorUnidad: valorPorUnidadLote,
      })),
    ];
  }, [operaciones, posicionesAbiertas, valorPorUnidadLote]);

  const alGrafico = useCallback((msg: unknown) => {
    if (Platform.OS === 'web') iframeRef.current?.contentWindow?.postMessage(msg, '*');
    else webviewRef.current?.injectJavaScript(`window.__rn(${JSON.stringify(msg)}); true;`);
  }, []);

  useEffect(() => {
    if (!esWeb) return;
    const alMensaje = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const d = event.data as { type?: string } | null;
      if (d && d.type === 'listo') setListo(true);
    };
    window.addEventListener('message', alMensaje);
    return () => window.removeEventListener('message', alMensaje);
  }, [esWeb]);

  useEffect(() => {
    let cancelado = false;
    setErrorLentes('');
    cargarLentesRef.current().then((resultado) => {
      if (!cancelado) setLentesReplay(resultado);
    }).catch((e) => {
      if (!cancelado) {
        const detalle = e instanceof Error ? e.message : 'No se pudo cargar la estructura histórica.';
        setErrorLentes(detalle.includes('404')
          ? 'La ruta de lentes no está en el backend activo. Reinícialo y vuelve a intentar.'
          : detalle);
      }
    });
    return () => { cancelado = true; };
  }, [simbolo, desde, hasta, intentoLentes]);

  // Recuerda en qué momento va el replay para conservarlo al cambiar de temporalidad.
  useEffect(() => {
    const v = serie.velas[indice - 1];
    if (v) tiempoRef.current = v.time;
  }, [indice, serie]);

  // Cambio de temporalidad: M-base sale del resultado; las demás se piden al servidor.
  useEffect(() => {
    let cancelado = false;
    (async () => {
      setError('');
      if (tf === base) {
        setSerie({ tf, velas });
        setIndice(Math.max(1, velasHasta(velas, tiempoRef.current)));
        return;
      }
      setCargando(true);
      try {
        const nuevas = await cargarRef.current(tf);
        if (cancelado) return;
        if (!nuevas.length) throw new Error(`No hay velas de ${tf} en este rango`);
        setSerie({ tf, velas: nuevas });
        setIndice(Math.max(1, velasHasta(nuevas, tiempoRef.current)));
      } catch (e) {
        if (!cancelado) setError(e instanceof Error ? e.message : `No se pudieron cargar las velas de ${tf}`);
      } finally {
        if (!cancelado) setCargando(false);
      }
    })();
    return () => { cancelado = true; };
  }, [tf, base, velas]);

  useEffect(() => {
    if (!listo) return;
    alGrafico({
      type: 'replay', simbolo, tf: serie.tf, tfSeg: TF_SEG_REPLAY[serie.tf] ?? 60,
      velas: serie.velas, ops, indice: indiceRef.current, conservarVista: false,
      lentes: lentesReplay.lentes, zonas: lentesReplay.zonas,
      temporalidades_faltantes: lentesReplay.temporalidades_faltantes,
    });
  }, [listo, serie, ops, simbolo, lentesReplay, alGrafico]);

  useEffect(() => {
    if (listo) alGrafico({ type: 'indice', indice });
  }, [listo, indice, alGrafico]);

  useEffect(() => {
    if (!reproduciendo) return;
    const id = setInterval(() => setIndice((i) => Math.min(serie.velas.length, i + velocidad)), 250);
    return () => clearInterval(id);
  }, [reproduciendo, velocidad, serie.velas.length]);

  useEffect(() => {
    if (reproduciendo && indice >= serie.velas.length) setReproduciendo(false);
  }, [reproduciendo, indice, serie.velas.length]);

  const irAOperacion = (dir: 1 | -1) => {
    setReproduciendo(false);
    const pos = ops.map((o) => velasHasta(serie.velas, o.tA)).filter((c) => c > 0).sort((a, b) => a - b);
    const destino = dir === 1 ? pos.find((c) => c > indice) : [...pos].reverse().find((c) => c < indice);
    if (destino) setIndice(Math.min(serie.velas.length, destino));
  };

  const tAhora = serie.velas[indice - 1]?.time ?? 0;
  const seg = TF_SEG_REPLAY[serie.tf] ?? 60;
  const cerradas = ops.filter((o) => o.tC !== null && o.tC !== undefined && Math.floor(o.tC / seg) * seg <= tAhora);
  const abiertas = ops.filter((o) => (
    Math.floor(o.tA / seg) * seg <= tAhora
    && (o.tC === null || o.tC === undefined || Math.floor(o.tC / seg) * seg > tAhora)
  ));
  const precioAhora = serie.velas[indice - 1]?.close;
  const profitFlotante = abiertas.reduce((total, o) => {
    if (typeof precioAhora !== 'number' || typeof o.vol !== 'number') return total;
    return total + (precioAhora - o.entrada) * (o.lado === 'compra' ? 1 : -1) * o.vol * valorPorUnidadLote;
  }, 0);
  const pl = cerradas.reduce((a, o) => a + (typeof o.profit === 'number' && Number.isFinite(o.profit) ? o.profit : 0), 0);
  const operacionesPanel = pestanaOps === 'historial' ? cerradas : abiertas;
  const tfs = (TF_REPLAY as readonly string[]).includes(base) ? [...TF_REPLAY] : [base, ...TF_REPLAY];

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#0a1118' }}>
        <View style={r.cabecera}>
          <View style={{ flex: 1 }}>
            <Text style={r.titulo}>{simbolo} · {serie.tf}  <Text style={r.etiqueta}>REPLAY</Text></Text>
            <Text style={r.sub}>{`${desde} — ${hasta} · ${cerradas.length} cerradas · ${abiertas.length} abiertas · P/L ${pl >= 0 ? '+' : ''}${pl.toFixed(2)} · Flotante ${profitFlotante >= 0 ? '+' : ''}${profitFlotante.toFixed(2)}`}</Text>
            {errorLentes ? (
              <View style={r.errorLentesFila}>
                <Text style={r.errorLentesTexto}>Lentes: {errorLentes}</Text>
                <Pressable onPress={() => setIntentoLentes((n) => n + 1)}><Text style={r.reintentarLentes}>Reintentar</Text></Pressable>
              </View>
            ) : null}
          </View>
          <Pressable onPress={onClose} style={r.cerrar}><Text style={r.cerrarTxt}>✕ Cerrar</Text></Pressable>
        </View>
        {error ? <Text style={s.error}>{error}</Text> : null}
        {cargando ? <Text style={r.sub}>Cargando velas de {tf}…</Text> : null}
        <View style={{ flex: 1, position: 'relative', backgroundColor: '#0a1118' }}>
          {esWeb
            ? createElement('iframe', {
                ref: iframeRef,
                srcDoc: html,
                title: 'Replay del backtest',
                style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none', backgroundColor: '#0a1118' },
              })
            : <WebView
                ref={webviewRef}
                originWhitelist={['*']}
                source={{ html }}
                style={{ flex: 1, backgroundColor: '#0a1118' }}
                javaScriptEnabled
                domStorageEnabled
                nestedScrollEnabled
                mixedContentMode="always"
                onMessage={(event) => {
                  try {
                    const d = JSON.parse(event.nativeEvent.data) as { type?: string };
                    if (d.type === 'listo') setListo(true);
                  } catch { /* mensaje ajeno al gráfico */ }
                }}
              />}
        </View>
        <View style={[r.panelOps, { height: panelOpsAbierto ? 205 : 40 }]}>
          <View style={r.pestanasOps}>
            <Pressable onPress={() => { setPestanaOps('abiertas'); setPanelOpsAbierto(true); }} style={[r.pestanaOps, pestanaOps === 'abiertas' && r.pestanaOpsActiva]}>
              <Text style={[r.pestanaOpsTexto, pestanaOps === 'abiertas' && r.pestanaOpsTextoActivo]}>Abiertas {abiertas.length}</Text>
            </Pressable>
            <Pressable onPress={() => { setPestanaOps('historial'); setPanelOpsAbierto(true); }} style={[r.pestanaOps, pestanaOps === 'historial' && r.pestanaOpsActiva]}>
              <Text style={[r.pestanaOpsTexto, pestanaOps === 'historial' && r.pestanaOpsTextoActivo]}>Historial {cerradas.length}</Text>
            </Pressable>
            <Pressable onPress={() => setPanelOpsAbierto((abierto) => !abierto)} style={r.alternarOps}>
              <Text style={r.pestanaOpsTexto}>{panelOpsAbierto ? 'Minimizar ﹀' : 'Ampliar ︿'}</Text>
            </Pressable>
          </View>
          {panelOpsAbierto && operacionesPanel.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View style={{ minWidth: 850 }}>
                <View style={r.filaTablaOps}>
                  <Text style={[r.celdaTablaOps, { width: 42 }]}>#</Text>
                  <Text style={[r.celdaTablaOps, { width: 115 }]}>Estado / tipo</Text>
                  <Text style={[r.celdaTablaOps, { width: 72 }]}>Vol.</Text>
                  <Text style={[r.celdaTablaOps, { width: 175 }]}>Entrada → salida</Text>
                  <Text style={[r.celdaTablaOps, { width: 105 }]}>Resultado</Text>
                  <Text style={[r.celdaTablaOps, { width: 145 }]}>Riesgo en SL / tope</Text>
                  <Text style={[r.celdaTablaOps, { width: 180 }]}>Cierre / duración</Text>
                </View>
                <ScrollView style={{ maxHeight: 145 }} nestedScrollEnabled>
                  {operacionesPanel.slice().reverse().map((o, i) => {
                    const estaAbierta = pestanaOps === 'abiertas';
                    const gapSL = o.motivo === 'sl' && typeof o.cierre === 'number'
                      ? Math.max(0, o.lado === 'compra' ? o.sl - o.cierre : o.cierre - o.sl)
                      : null;
                    const resultado = estaAbierta
                      ? (typeof precioAhora === 'number' && typeof o.vol === 'number'
                        ? (precioAhora - o.entrada) * (o.lado === 'compra' ? 1 : -1) * o.vol * valorPorUnidadLote
                        : 0)
                      : (o.profit ?? 0);
                    const precioSalida = estaAbierta ? precioAhora : o.cierre;
                    const riesgo = estaAbierta ? (o.riesgoActual ?? o.riesgoReal) : o.riesgoReal;
                    const excesoSobreSL = !estaAbierta && o.motivo === 'sl' && typeof o.profit === 'number' && typeof o.riesgoReal === 'number'
                      ? Math.max(0, -o.profit - o.riesgoReal)
                      : 0;
                    const destino = velasHasta(serie.velas, o.tA);
                    return (
                      <Pressable key={`${o.id}-${o.tA}`} onPress={() => { setReproduciendo(false); if (destino > 0) setIndice(destino); }} style={r.filaTablaOps}>
                        <Text style={[r.celdaTablaOps, { width: 42 }]}>{o.id}</Text>
                        <Text style={[r.celdaTablaOps, { width: 115, color: estaAbierta ? '#e4b75a' : o.lado === 'compra' ? '#4cc38a' : '#e5646b' }]}>{estaAbierta ? 'ABIERTA' : 'CERRADA'} · {o.lado === 'compra' ? 'Compra' : 'Venta'}</Text>
                        <Text style={[r.celdaTablaOps, { width: 72 }]}>{o.vol ?? '—'}</Text>
                        <Text style={[r.celdaTablaOps, { width: 175 }]}>{`${o.entrada.toFixed(2)} → ${typeof precioSalida === 'number' ? precioSalida.toFixed(2) : '—'}\nSL ${o.sl.toFixed(2)}${gapSL !== null ? ` · gap OHLC ${gapSL.toFixed(2)}` : ''}`}</Text>
                        <Text style={[r.celdaTablaOps, { width: 105, color: resultado >= 0 ? '#4cc38a' : '#e5646b' }]}>{resultado >= 0 ? '+' : ''}{resultado.toFixed(2)}</Text>
                        <Text style={[r.celdaTablaOps, { width: 145 }]}>{riesgo == null ? '—' : `${o.riesgoEstimado ? '~' : ''}${riesgo.toFixed(2)}`} / {o.riesgoObjetivo?.toFixed(2) ?? '—'}{excesoSobreSL > 0 ? `\nSobre SL: ${excesoSobreSL.toFixed(2)}` : ''}</Text>
                        <Text style={[r.celdaTablaOps, { width: 180 }]}>{estaAbierta ? 'En curso' : `${o.motivo || 'Cierre'} · ${o.tC ? new Date(o.tC * 1000).toLocaleString() : '—'}`}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            </ScrollView>
          ) : panelOpsAbierto ? <Text style={r.vacioOps}>{pestanaOps === 'abiertas' ? 'No hay operaciones abiertas en este punto del replay.' : 'Todavía no hay operaciones cerradas en este punto del replay.'}</Text> : null}
        </View>
        <View style={r.barra}>
          <View style={r.pista}><View style={[r.relleno, { width: `${(indice / Math.max(1, serie.velas.length)) * 100}%` }]} /></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', gap: 6, paddingHorizontal: 8 }}>
            <Pressable style={s.tf} onPress={() => { setReproduciendo(false); setIndice(Math.min(inicio, serie.velas.length)); }}><Text style={s.tfTexto}>⏮</Text></Pressable>
            <Pressable style={s.tf} onPress={() => { setReproduciendo(false); setIndice((i) => Math.max(1, i - 1)); }}><Text style={s.tfTexto}>-1</Text></Pressable>
            <Pressable style={[s.tf, { backgroundColor: '#237a4b', borderColor: '#237a4b' }]} onPress={() => { if (!cargando) setReproduciendo((x) => !x); }}><Text style={[s.tfTexto, { color: '#fff' }]}>{reproduciendo ? '⏸' : '▶'}</Text></Pressable>
            <Pressable style={s.tf} onPress={() => { setReproduciendo(false); setIndice((i) => Math.min(serie.velas.length, i + 1)); }}><Text style={s.tfTexto}>+1</Text></Pressable>
            <Pressable style={s.tf} onPress={() => { setReproduciendo(false); setIndice((i) => Math.min(serie.velas.length, i + 10)); }}><Text style={s.tfTexto}>+10</Text></Pressable>
            <Pressable style={s.tf} onPress={() => setVelocidad((v) => VELOCIDADES_REPLAY[(VELOCIDADES_REPLAY.indexOf(v) + 1) % VELOCIDADES_REPLAY.length])}><Text style={s.tfTexto}>{velocidad}x</Text></Pressable>
            <Text style={r.contador}>{indice}/{serie.velas.length}</Text>
            {ops.length ? <Pressable style={s.tf} onPress={() => irAOperacion(-1)}><Text style={s.tfTexto}>◀ Op.</Text></Pressable> : null}
            {ops.length ? <Pressable style={s.tf} onPress={() => irAOperacion(1)}><Text style={s.tfTexto}>Op. ▶</Text></Pressable> : null}
            {tfs.map((t) => (
              <Pressable key={t} onPress={() => { setReproduciendo(false); setTf(t); }} style={[s.tf, tf === t && s.tfActivo]}>
                <Text style={[s.tfTexto, tf === t && s.tfTextoActivo]}>{t}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const r = StyleSheet.create({
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, backgroundColor: '#111b25', borderBottomWidth: 1, borderBottomColor: '#243440' },
  titulo: { color: '#e9eef2', fontSize: 15, fontWeight: '800' },
  etiqueta: { color: '#d7ae5b', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  sub: { color: '#93a2af', fontSize: 11, marginTop: 3, paddingHorizontal: 2 },
  cerrar: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#79343a' },
  cerrarTxt: { color: '#fff', fontSize: 12, fontWeight: '800' },
  panelOps: { backgroundColor: '#111b25', borderTopWidth: 1, borderTopColor: '#243440', overflow: 'hidden' },
  pestanasOps: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#243440' },
  pestanaOps: { paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  alternarOps: { marginLeft: 'auto', paddingHorizontal: 14, paddingVertical: 9 },
  pestanaOpsActiva: { borderBottomColor: '#d7ae5b' },
  pestanaOpsTexto: { color: '#93a2af', fontSize: 12, fontWeight: '700' },
  pestanaOpsTextoActivo: { color: '#e2eaf0' },
  errorLentesFila: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 3 },
  errorLentesTexto: { color: '#ffb4b4', fontSize: 11, flex: 1 },
  reintentarLentes: { color: '#e4b75a', fontSize: 11, fontWeight: '700' },
  filaTablaOps: { minHeight: 34, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#243440', paddingHorizontal: 8 },
  celdaTablaOps: { color: '#a5b2bc', fontSize: 11, paddingHorizontal: 5, fontVariant: ['tabular-nums'] },
  vacioOps: { color: '#93a2af', fontSize: 12, padding: 14 },
  barra: { backgroundColor: '#111b25', borderTopWidth: 1, borderTopColor: '#243440', paddingTop: 7, paddingBottom: 11 },
  pista: { height: 3, backgroundColor: '#0c151d', borderRadius: 2, overflow: 'hidden', marginHorizontal: 8, marginBottom: 7 },
  relleno: { height: '100%', backgroundColor: '#d7ae5b' },
  contador: { color: '#93a2af', fontSize: 11, fontWeight: '700', paddingHorizontal: 4 },
});

const s = StyleSheet.create({
  caja: { backgroundColor: '#111b25', borderWidth: 1, borderColor: '#22313d', borderRadius: 13, padding: 14, marginBottom: 14 },
  fila: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 },
  input: { backgroundColor: '#0c151d', borderWidth: 1, borderColor: '#2b3b48', borderRadius: 9, color: '#edf2f5', paddingHorizontal: 10, paddingVertical: 9, minWidth: 110, fontWeight: '700' },
  pastilla: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
  punto: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  pastillaTexto: { fontSize: 11, fontWeight: '800' },
  precioInline: { color: '#dce5eb', fontSize: 13, fontWeight: '700', marginLeft: 4 },
  ampliar: { marginLeft: 'auto', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#0c151d', borderWidth: 1, borderColor: '#2b3b48' },
  ampliarTexto: { color: '#d7ae5b', fontSize: 12, fontWeight: '800' },
  tf: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, backgroundColor: '#0c151d', borderWidth: 1, borderColor: '#2b3b48' },
  tfActivo: { backgroundColor: '#d7ae5b', borderColor: '#d7ae5b' },
  tfTexto: { color: '#93a2af', fontSize: 12, fontWeight: '700' },
  tfTextoActivo: { color: '#111a22' },
  error: { color: '#f29aa0', backgroundColor: '#2d1d23', padding: 11, borderRadius: 9, marginBottom: 8, fontSize: 12 },
  ticketFondo: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, backgroundColor: 'rgba(0,0,0,0.72)' },
  ticketPanel: { width: '100%', maxWidth: 460, maxHeight: '90%', overflow: 'hidden', padding: 18, borderWidth: 1, borderColor: '#334553', borderRadius: 12, backgroundColor: '#111b25' },
  ticketScroll: { flexShrink: 1 },
  ticketContenido: { paddingBottom: 2 },
  ticketTitulo: { color: '#edf2f5', fontSize: 18, fontWeight: '800' },
  ticketPrecio: { color: '#a5b2bc', fontSize: 12, marginTop: 4, marginBottom: 14 },
  ticketEtiqueta: { color: '#93a2af', fontSize: 10, fontWeight: '800', letterSpacing: 0.7, marginBottom: 7 },
  ticketFila: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 9 },
  ticketOpcion: { flex: 1, alignItems: 'center', paddingVertical: 9, borderWidth: 1, borderColor: '#2b3b48', borderRadius: 7, backgroundColor: '#0c151d' },
  ticketOpcionActiva: { borderColor: '#d7ae5b', backgroundColor: '#302b1d' },
  ticketOpcionTexto: { color: '#93a2af', fontSize: 13, fontWeight: '700' },
  ticketOpcionTextoActiva: { color: '#f0d48e' },
  ticketInput: { minWidth: 0, marginBottom: 9, paddingHorizontal: 10, paddingVertical: 10, borderWidth: 1, borderColor: '#2b3b48', borderRadius: 7, backgroundColor: '#0c151d', color: '#edf2f5', fontSize: 14, flex: 1 },
  ticketMitad: { flex: 1 },
  ticketNota: { color: '#e4b75a', fontSize: 11, lineHeight: 16, marginBottom: 10 },
  ticketResultado: { color: '#f29aa0', backgroundColor: '#2d1d23', padding: 9, borderRadius: 7, marginBottom: 10, fontSize: 12 },
  ticketCancelar: { flex: 1, alignItems: 'center', paddingVertical: 10, borderWidth: 1, borderColor: '#394552', borderRadius: 7, backgroundColor: '#0c151d' },
  ticketCancelarTexto: { color: '#c4ced6', fontSize: 13, fontWeight: '700' },
  ticketEnviar: { flex: 1, alignItems: 'center', paddingVertical: 10, borderWidth: 1, borderColor: '#237a4b', borderRadius: 7, backgroundColor: '#237a4b' },
  ticketEnviarTexto: { color: '#fff', fontSize: 13, fontWeight: '800' },
  ticketDeshabilitado: { opacity: 0.55 },
  grafico: { height: 560, borderRadius: 10, overflow: 'hidden', backgroundColor: '#0a1118' },
  graficoWeb: { position: 'relative', borderRadius: 10, overflow: 'hidden', backgroundColor: '#0a1118' },
  graficoLleno: { position: 'relative', flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, borderRadius: 10, overflow: 'hidden', backgroundColor: '#0a1118' },
});