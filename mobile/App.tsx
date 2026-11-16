import { StatusBar } from 'expo-status-bar';
import DateTimePicker from '@react-native-community/datetimepicker';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, Text, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { z } from 'zod';
import { PanelAnalista, ListaActivos } from './src/PanelAnalista';
import { GraficoVivo, GraficoReplay, type LentesReplayGv } from './src/GraficoVivo';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'android' ? 'http://10.0.2.2:8000' : 'http://localhost:8000');
// Debe ser el mismo valor que API_KEY en el .env del backend. Se mete como
// variable de build (EXPO_PUBLIC_API_KEY) para no dejar el token hardcodeado
// en el repo.
const API_KEY = process.env.EXPO_PUBLIC_API_KEY || '';
type AppTab = 'mercado' | 'vivo' | 'proyecciones' | 'estrategia' | 'operar' | 'riesgo' | 'historial' | 'fundamentales' | 'backtesting' | 'telegram';
const NAV_ITEMS: { key: AppTab; label: string; short: string }[] = [
  { key: 'mercado', label: 'Resumen', short: 'IN' },
  { key: 'vivo', label: 'En vivo', short: 'TV' },
  { key: 'proyecciones', label: 'Proyecciones', short: 'PX' },
  { key: 'estrategia', label: 'Estrategia', short: 'ES' },
  { key: 'operar', label: 'Operar', short: 'OP' },
  { key: 'riesgo', label: 'Riesgo', short: 'RG' },
  { key: 'historial', label: 'Historial', short: 'HI' },
  { key: 'fundamentales', label: 'Calendario', short: 'CA' },
  { key: 'backtesting', label: 'Backtesting', short: 'BT' },
  { key: 'telegram', label: 'Telegram', short: 'TG' },
];
// Mismo mapeo que TEMPORALIDADES en backend/estructura.py — se muestra en el
// panel para que quede claro qué temporalidad escrita cae en cada grupo.
const GRUPO_TEMPORALIDAD: Record<string, 'micro' | 'intermedia' | 'macro' | 'extra_macro'> = {
  M1: 'micro', M3: 'micro', M5: 'micro',
  M15: 'intermedia', M30: 'intermedia', H1: 'intermedia',
  H2: 'macro', H4: 'macro', D1: 'macro',
  W1: 'extra_macro', MN1: 'extra_macro',
};
const TEMPORALIDADES_ESCANEO = Object.keys(GRUPO_TEMPORALIDAD);
// El texto se guarda como "M15:macro, H1:intermedia" — estas dos funciones
// van y vuelven entre ese texto y un objeto {tf: grupo} fácil de usar.
function parseGruposTexto(texto: string): Record<string, string> {
  const out: Record<string, string> = {};
  texto.split(',').map((par) => par.trim()).filter(Boolean).forEach((par) => {
    const [tf, grupo] = par.split(':').map((x) => x.trim());
    if (tf && grupo) out[tf.toUpperCase()] = grupo.toLowerCase();
  });
  return out;
}
function serializeGruposTexto(obj: Record<string, string>): string {
  return Object.entries(obj).map(([tf, grupo]) => `${tf}:${grupo}`).join(', ');
}

// --- Schemas: fuente única de verdad para la forma de los datos que manda el backend. ---
// Los `type` se derivan de estos schemas con z.infer, así que nunca quedan desincronizados
// entre sí. Si servidor.py cambia la forma de una respuesta y el schema no se actualiza,
// api() revienta con un error legible en vez de dejar pasar datos con forma incorrecta.
const ParamSchema = z.object({ nombre: z.string(), etiqueta: z.string(), tipo: z.string(), default: z.union([z.string(), z.number()]) });
const BlockSchema = z.object({ nombre: z.string(), explicacion: z.string(), parametros: z.array(ParamSchema) });
const ContextoTemporalidadSchema = z.object({
  grupo: z.string(),
  sesgo: z.enum(['alcista', 'bajista']).nullable(),
  ultimo_maximo: z.object({ precio: z.number(), clase: z.string().nullable() }).nullable(),
  ultimo_minimo: z.object({ precio: z.number(), clase: z.string().nullable() }).nullable(),
  acumulacion: z.object({
    techo: z.number(),
    piso: z.number(),
    indice_inicio: z.number(),
    indice_fin: z.number(),
    toques: z.number(),
  }).nullable(),
  liquidez_externa: z.array(z.object({
    tipo: z.string(),
    precio: z.number(),
    barrida: z.boolean(),
  })),
});
const ContextoEstructuraSchema = z.object({
  temporalidades: z.record(z.string(), ContextoTemporalidadSchema),
  conflictos: z.array(z.object({
    mayor: z.string(),
    sesgo_mayor: z.string(),
    menor: z.string(),
    sesgo_menor: z.string(),
  })),
}).nullable().optional();
type ConflictoTemporalidad = {
  mayor: string;
  sesgo_mayor: string;
  menor: string;
  sesgo_menor: string;
};
function agruparConflictos(conflictos: ConflictoTemporalidad[]) {
  const grupos = new Map<string, {
    mayor: string;
    sesgo_mayor: string;
    sesgo_menor: string;
    menores: Set<string>;
  }>();
  for (const conflicto of conflictos) {
    const clave = JSON.stringify([conflicto.mayor, conflicto.sesgo_mayor, conflicto.sesgo_menor]);
    let grupo = grupos.get(clave);
    if (!grupo) {
      grupo = {
        mayor: conflicto.mayor,
        sesgo_mayor: conflicto.sesgo_mayor,
        sesgo_menor: conflicto.sesgo_menor,
        menores: new Set<string>(),
      };
      grupos.set(clave, grupo);
    }
    grupo.menores.add(conflicto.menor);
  }
  return Array.from(grupos.values()).map(({ menores, ...grupo }) => ({
    ...grupo,
    menores: Array.from(menores),
  }));
}
const UltimaOrdenSchema = z.object({ ok: z.boolean().optional(), ticket: z.number().optional(), precio: z.number().optional(), error: z.string().optional() }).nullable().optional();
const StateSchema = z.object({
  conectado: z.boolean(),
  precio: z.object({ bid: z.number(), ask: z.number() }).nullable(),
  senal: z.string().nullable(),
  ultima_actualizacion: z.string().nullable(),
  simbolo_actual: z.string().nullable().optional(),
  error: z.string().nullable(),
  sesgo_macro: z.enum(['alcista', 'bajista']).nullable().optional(),
  contexto_estructura: ContextoEstructuraSchema,
  ultima_orden: UltimaOrdenSchema,
  circuito_disparado: z.boolean().optional(),
  config: z.object({ simbolo: z.string(), simbolos_permitidos: z.array(z.string()).optional(), activo: z.boolean(), estrategia: z.string().nullable().optional(), estrategia_biblioteca_activa: z.string().nullable().optional(), timeframe_entrada: z.string().optional(), timeframe_macro: z.string().optional(), volumen_operacion: z.number().optional(), circuito_perdida_diaria_activo: z.boolean().optional(), circuito_perdida_diaria_pct: z.number().optional(), spread_maximo_puntos: z.number().optional(), max_operaciones_por_simbolo: z.number().optional(), filtro_sesgo_macro: z.boolean().optional(), aviso_cambio_direccion: z.boolean().optional(), proteger_cambio_direccion: z.boolean().optional(), noticia_be_activo: z.boolean().optional(), bloqueo_noticias_activo: z.boolean().optional(), be_activo: z.boolean().optional(), be_porcentaje: z.number().optional(), be_cascada_buffer_pct: z.number().optional(), be_dinamico_activo: z.boolean().optional(), be_dinamico_fibo_nivel: z.number().optional(), grupos_temporalidad: z.record(z.string(), z.string()).optional(), temporalidades_escaneo: z.array(z.string()).optional(), parametros: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.number())])).optional() }).optional(),
});
const AnalistaWatchlistSchema = z.object({
  simbolos: z.array(z.string()),
  operar: z.array(z.string()),
  ejecucion_activa: z.boolean(),
});
const ProyeccionAnalistaSchema = z.object({
  simbolo: z.string(),
  direccion: z.enum(['alcista', 'bajista', 'acumulacion']),
  estado: z.string(),
  zona: z.string(),
  zona_tf: z.string(),
  zona_rango: z.tuple([z.number(), z.number()]),
  fuerza_rompimiento: z.string(),
  entrada: z.number(),
  sl: z.number(),
  operaciones: z.array(z.object({
    nombre: z.string(),
    tp: z.number(),
    peso: z.number(),
    rr: z.number(),
  }).passthrough()),
  score: z.number(),
  confluencias: z.array(z.string()),
  notas: z.array(z.string()),
  alineacion: z.number(),
  clave: z.string(),
  ejecutada: z.boolean().optional(),
  en_curso: z.boolean().optional(),
  lotes: z.array(z.object({ operacion: z.string(), lote: z.number(), riesgo: z.number() })),
}).passthrough();
const ProyeccionesSchema = z.object({
  escaner: z.object({
    corriendo: z.boolean(),
    ultima: z.string().nullable(),
    hace_min: z.number().nullable(),
    intervalo_min: z.number(),
  }),
  ejecucion_activa: z.boolean(),
  todas_las_proyecciones: z.boolean().optional(),
  mt5_conectado: z.boolean(),
  cuenta_real: z.boolean(),
  moneda: z.string().nullable(),
  manual_permitido: z.boolean(),
  activos: z.array(z.object({
    simbolo: z.string(),
    mt5: z.string(),
    marcado_operar: z.boolean(),
    estado: z.string(),
    detalle: z.string(),
    escenarios: z.array(ProyeccionAnalistaSchema),
    posiciones: z.array(z.object({
      ticket: z.number(),
      tipo: z.string(),
      volumen: z.number(),
      precio_apertura: z.number(),
      precio_actual: z.number(),
      profit: z.number(),
      sl: z.number().nullable(),
      tp: z.number().nullable(),
    }).passthrough()),
  })),
});
const AccountSchema = z.object({ cuenta: z.number(), servidor: z.string(), balance: z.number(), equity: z.number(), profit: z.number(), apalancamiento: z.number(), moneda: z.string(), es_real: z.boolean() });
const AccountResponseSchema = z.union([AccountSchema, z.object({ error: z.string() })]);
const PositionSchema = z.object({ ticket: z.number(), simbolo: z.string(), tipo: z.string(), volumen: z.number(), precio_apertura: z.number(), precio_actual: z.number(), profit: z.number(), hora_apertura: z.number().optional() });
const BulkActionResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  accion: z.string().optional(),
  simbolo: z.string().optional(),
  tipo: z.string().optional(),
  total: z.number().optional(),
  exitosas: z.array(z.object({ ticket: z.number(), sl: z.number().optional() })).optional(),
  omitidas: z.array(z.object({ ticket: z.number(), motivo: z.string() })).optional(),
  fallidas: z.array(z.object({ ticket: z.number(), error: z.string() })).optional(),
});

// Formatea un timestamp (epoch en segundos) a hora local del dispositivo en
// formato 12 horas (AM/PM), sin importar el idioma/región del teléfono.
function formatearHora12(epochSegundos?: number | null): string {
  if (!epochSegundos) return 'sin dato';
  const fecha = new Date(epochSegundos * 1000);
  const fechaTxt = fecha.toLocaleDateString();
  const horaTxt = fecha.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${fechaTxt} ${horaTxt}`;
}
const SavedSchema = z.object({ nombre: z.string(), explicacion: z.string(), codigo: z.string(), volumen: z.number(), sl: z.number(), tp: z.number(), usa_multi_temporalidad: z.boolean().optional(), timeframe_entrada: z.string().optional(), timeframe_macro: z.string().optional(), temporalidades_escaneo: z.array(z.string()).optional(), roles_temporalidad: z.record(z.string(), z.string()).optional(), zonas_permitidas: z.array(z.string()).optional(), parametros: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.number())])).optional() });
const TelegramConfigSchema = z.object({ activo: z.boolean(), bot_token: z.string(), chat_id: z.string(), aviso_apertura: z.boolean(), aviso_cierre: z.boolean(), aviso_sl_tp: z.boolean(), aviso_parcial: z.boolean(), aviso_zona: z.boolean() });
const TelegramProbarSchema = z.object({ ok: z.boolean(), error: z.string().optional() });
const HistoryItemSchema = z.object({ ticket: z.number(), simbolo: z.string(), tipo: z.string(), volumen: z.number(), profit: z.number(), hora: z.number() });
const EstadisticasSchema = z.object({ total_operaciones: z.number(), ganadoras: z.number(), perdedoras: z.number(), winrate_pct: z.number(), ganancia_total: z.number(), mejor_operacion: z.number(), peor_operacion: z.number(), profit_factor: z.number().nullable(), racha_actual: z.number() });
const DiarioSchema = z.object({ id: z.number(), ticket: z.number(), estado: z.string(), simbolo: z.string(), tipo: z.string(), volumen: z.number(), entrada: z.number().nullable(), sl: z.number().nullable(), tp: z.number().nullable(), origen: z.string().optional(), perdida_estimada: z.number().nullable().optional(), ganancia_estimada: z.number().nullable().optional(), ratio_rr: z.number().nullable().optional(), hora_apertura: z.number(), hora_cierre: z.number().nullable(), resultado: z.string().nullable(), profit: z.number().nullable(), precio_cierre: z.number().nullable(), duracion_seg: z.number().nullable(), notas: z.string().optional() });
const ResumenGrupoSchema = z.object({ operaciones: z.number(), winrate_pct: z.number(), profit: z.number() });
const DiarioStatsSchema = z.object({ total: ResumenGrupoSchema, por_resultado: z.record(z.string(), ResumenGrupoSchema), por_simbolo: z.record(z.string(), ResumenGrupoSchema), por_origen: z.record(z.string(), ResumenGrupoSchema) });
const NotaBitacoraSchema = z.object({ id: z.number(), hora: z.number(), ticket: z.number().nullable(), nota: z.string() });
const BloquesDisponiblesSchema = z.object({ bloques: z.record(z.string(), BlockSchema) });
const RunResultSchema = z.object({ ok: z.boolean().optional(), ticket: z.number().optional(), precio: z.number().optional(), error: z.string().optional() });
const FundamentalEventoSchema = z.object({ title: z.string(), country: z.string().optional(), date: z.string(), impact: z.string().optional(), forecast: z.union([z.string(), z.number()]).optional(), previous: z.union([z.string(), z.number()]).optional(), actual: z.union([z.string(), z.number()]).optional(), sorpresa: z.string().nullable().optional(), sin_dato: z.boolean().optional() }).passthrough();
const FundamentalesSchema = z.object({ pendientes: z.array(FundamentalEventoSchema), en_proceso: z.array(FundamentalEventoSchema), pasados: z.array(FundamentalEventoSchema) });

// --- Backtesting ---
const TradeSchema = z.object({ tipo: z.string(), entrada: z.number(), sl: z.number(), tp: z.number(), salida: z.number(), volumen: z.number(), profit: z.number(), hora_apertura: z.string(), hora_cierre: z.string(), motivo_cierre: z.enum(['sl', 'tp', 'be']).optional(), be_aplicado: z.boolean().optional(), riesgo_objetivo: z.number().optional(), riesgo_real: z.number().optional() });
const EquityPointSchema = z.object({ tiempo: z.string(), balance: z.number() });
const VelaReplaySchema = z.object({ time: z.number(), open: z.number(), high: z.number(), low: z.number(), close: z.number() });
const PasoEstrategiaSchema = z.object({
  time: z.number(),
  tipo: z.string(),
  texto: z.string(),
  escenario_id: z.string().nullable().optional(),
  activo: z.boolean().optional(),
  zona: z.string().nullable().optional(),
  zona_tf: z.string().nullable().optional(),
  zona_rango: z.array(z.number()).optional(),
  entrada: z.number().nullable().optional(),
  sl: z.number().nullable().optional(),
  tp: z.number().nullable().optional(),
  direccion: z.string().nullable().optional(),
  estado: z.string().nullable().optional(),
});
const BacktestDiagnosticSchema = z.object({
  estrategia_activa: z.string(),
  tipo_estrategia: z.string(),
  timeframes_configurados: z.array(z.string()),
  timeframes_recibidos: z.array(z.string()),
  timeframes_faltantes: z.array(z.string()),
  evaluaciones_estrategia: z.number(),
  senales_detectadas: z.number(),
  oportunidades_detectadas: z.number(),
  entradas_ejecutadas: z.number(),
  senales_ignoradas_misma_direccion: z.number(),
});
const ReplayVelasResponseSchema = z.union([
  z.object({ timeframe: z.string(), velas: z.array(VelaReplaySchema) }),
  z.object({ error: z.string() }),
]);
const LentesReplaySchema: z.ZodType<LentesReplayGv> = z.object({
  lentes: z.array(z.object({
    nombre: z.string(),
    vista: z.string(),
    estructura: z.string(),
    direccion: z.string(),
    direccion_vista: z.string(),
    fase: z.string(),
    pivotes: z.array(z.object({
      time: z.number(),
      confirmacion: z.number().optional(),
      precio: z.number(),
      tipo: z.enum(['high', 'low']),
      clase: z.string(),
    })),
    quiebres: z.array(z.object({
      time: z.number(),
      precio: z.number(),
      direccion: z.string(),
      tipo: z.enum(['BOS', 'CHOCH']),
    })),
  })),
  zonas: z.array(z.object({
    estructura: z.string(), tipo: z.string(), direccion: z.string(), estado: z.string(),
    rango: z.tuple([z.number(), z.number()]),
  })),
  temporalidades_faltantes: z.array(z.string()),
});
const BacktestResultSchema = z.union([
  z.object({
    balance_inicial: z.number(),
    balance_final: z.number(),
    profit_total: z.number(),
    profit_flotante_al_final: z.number(),
    total_operaciones: z.number(),
    ganadoras: z.number(),
    perdedoras: z.number(),
    neutras: z.number().optional(),
    tasa_acierto: z.number(),
    max_drawdown: z.number(),
    posicion_abierta_al_final: z.object({
      tipo: z.string(),
      entrada: z.number(),
      sl: z.number(),
      tp: z.number(),
      volumen: z.number(),
      hora_apertura: z.string(),
      be_aplicado: z.boolean().optional(),
      profit_flotante: z.number().optional(),
      riesgo_objetivo: z.number().optional(),
      riesgo_real: z.number().optional(),
      riesgo_actual: z.number().optional(),
    }).nullable().optional(),
    posiciones_abiertas: z.array(z.object({
      tipo: z.string(),
      entrada: z.number(),
      sl: z.number(),
      tp: z.number(),
      volumen: z.number(),
      hora_apertura: z.string(),
      be_aplicado: z.boolean().optional(),
      profit_flotante: z.number(),
      riesgo_objetivo: z.number(),
      riesgo_real: z.number(),
      riesgo_actual: z.number(),
    })).optional(),
    valor_por_unidad_lote: z.number().optional(),
    operaciones: z.array(TradeSchema),
    pasos_estrategia: z.array(PasoEstrategiaSchema).optional(),
    curva_equity: z.array(EquityPointSchema),
    simbolo: z.string(),
    desde: z.string(),
    hasta: z.string(),
    velas_usadas: z.number(),
    velas: z.array(VelaReplaySchema),
    indice_inicio_replay: z.number().optional(),
    timeframe_entrada: z.string().nullable().optional(),
    timeframe_macro: z.string().nullable().optional(),
    aviso: z.string().nullable().optional(),
    diagnostico: BacktestDiagnosticSchema.optional(),
  }),
  z.object({ error: z.string() }),
]);
const BacktestStartSchema = z.object({ job_id: z.string() });
const BacktestDateRangeSchema = z.object({ desde: z.string().nullable(), hasta: z.string().nullable() });
const BacktestProgresoSchema = z.object({
  listo: z.boolean(),
  procesado: z.number(),
  total: z.number(),
  porcentaje: z.number(),
  resultado: BacktestResultSchema.nullable(),
}).or(z.object({ error: z.string() }));

type Param = z.infer<typeof ParamSchema>;
type Block = z.infer<typeof BlockSchema>;
type Condition = { bloque: string; parametros: Record<string, string | number> }; // esto se ENVÍA, no se recibe: no necesita schema
type State = z.infer<typeof StateSchema>;
type Account = z.infer<typeof AccountSchema>;
type Position = z.infer<typeof PositionSchema>;
type Saved = z.infer<typeof SavedSchema>;
type AccountResponse = z.infer<typeof AccountResponseSchema>;
type HistoryItem = z.infer<typeof HistoryItemSchema>;
type BacktestResult = z.infer<typeof BacktestResultSchema>;
type VelaReplay = z.infer<typeof VelaReplaySchema>;

// `api()` exige un schema y valida la respuesta real contra él antes de devolverla.
async function api<T>(path: string, schema: z.ZodType<T>, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { ...(options?.headers || {}), 'X-API-Key': API_KEY },
  });
  if (!response.ok) throw new Error(`Servidor: ${response.status}`);
  const json = await response.json();
  const result = schema.safeParse(json);
  if (!result.success) {
    console.error(`Respuesta inesperada de ${path}:`, result.error.format());
    const issue = result.error.issues[0];
    const campo = issue?.path.length ? issue.path.join('.') : 'respuesta';
    throw new Error(`Respuesta incompatible de ${path}: ${campo} — ${issue?.message || 'formato inesperado'}. Reinicia el backend si está usando código anterior.`);
  }
  return result.data;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
// --- Replay visual del backtest (estilo TradingView Replay / FX Replay) ---
// hora_apertura/hora_cierre vienen como "YYYY-MM-DD HH:MM:SS" (str() de un
// Timestamp de pandas creado con pd.to_datetime(..., unit="s"), es decir, ya
// representan el mismo instante UTC que las velas). Se parsean a mano con
// Date.UTC en vez de Date.parse() porque ese formato con espacio no es
// consistente entre motores JS (algunos lo interpretan como hora local).
function epochUTC(fechaStr: string): number {
  const [fecha, hora] = fechaStr.split(' ');
  const [y, m, d] = (fecha || '').split('-').map(Number);
  const [hh, mm, ss] = (hora || '0:0:0').split(':').map(Number);
  return Math.floor(Date.UTC(y || 1970, (m || 1) - 1, d || 1, hh || 0, mm || 0, ss || 0) / 1000);
}

// Tamaño de contrato aproximado para estimar el P/L de las operaciones manuales
// (mismo cálculo que el backtest: diferencia de precio * lotes * contrato).
function contratoDe(simbolo: string): number {
  const s = (simbolo || '').toUpperCase();
  if (s.startsWith('XAU')) return 100;
  if (s.startsWith('XAG')) return 5000;
  return 100000;
}

function construirHtmlReplay(velas: VelaReplay[], operaciones: { tipo: string; entrada: number; sl: number; tp: number; salida: number; profit: number; hora_apertura: string; hora_cierre: string; motivo_cierre?: 'sl' | 'tp' | 'be'; be_aplicado?: boolean; volumen?: number }[], pasosEstrategia: z.infer<typeof PasoEstrategiaSchema>[], contrato: number, estadoInicial: string): string {
  const ops = operaciones.map((op) => ({
    tipo: op.tipo,
    entrada: op.entrada,
    salida: op.salida,
    volumen: op.volumen,
    sl: op.sl,
    tp: op.tp,
    profit: op.profit,
    motivoCierre: op.motivo_cierre || (op.be_aplicado && op.salida === op.entrada ? 'be' : op.salida === op.sl ? 'sl' : op.salida === op.tp ? 'tp' : 'cierre'),
    aperturaEpoch: epochUTC(op.hora_apertura),
    cierreEpoch: epochUTC(op.hora_cierre),
  }));
  // El estado manual (dibujos + operaciones tomadas a mano) se guarda en epoch/precio,
  // así sobrevive al cambio de temporalidad (que recarga el iframe).
  const estadoSeguro = (estadoInicial || '{}').replace(/</g, '\\u003c');
  const pasosSeguros = JSON.stringify(pasosEstrategia).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#0b0f14;overflow:hidden;font-family:system-ui,Arial,sans-serif;}
#wrap{position:relative;width:100%;height:100%;}
#chart{position:absolute;left:0;top:0;right:0;bottom:0;}
#cv{position:absolute;left:0;top:0;z-index:5;pointer-events:none;}
.panel{position:absolute;z-index:10;background:rgba(21,27,35,.93);border:1px solid #2b3643;border-radius:8px;color:#e1e7ed;font-size:12px;}
#tools{left:6px;top:6px;padding:3px;display:flex;flex-wrap:wrap;gap:3px;max-width:60%;align-items:center;}
.grip{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;padding:0 6px;height:28px;display:flex;align-items:center;color:#8893a0;font-size:15px;letter-spacing:-3px;border-radius:5px;}
.grip:active{cursor:grabbing;color:#e4b75a;}
.panel.arrastrando{opacity:.85;box-shadow:0 6px 18px rgba(0,0,0,.5);}
#tools.mini > *:not(.keep){display:none;}
#tools.mini{flex-wrap:nowrap;max-width:none;}
#tools button{min-width:30px;height:28px;padding:0 5px;border:1px solid #33404d;border-radius:5px;background:#1d2530;color:#dce2e8;font-size:13px;cursor:pointer;}
#tools button.on{background:#b88b35;color:#0b0f14;border-color:#b88b35;}
#sep{width:1px;background:#33404d;margin:0 2px;}
#tz{position:absolute;right:0;bottom:0;z-index:15;box-sizing:border-box;background:#0b0f14;color:#dce2e8;border:0;border-left:1px solid #222c37;font-size:11px;padding:0 2px;cursor:pointer;}
#trade{right:68px;top:6px;padding:6px;width:236px;max-height:calc(100% - 90px);overflow-y:auto;}
#trade.mini{width:auto;overflow:visible;}
#tHead{display:flex;align-items:center;gap:4px;}
#tHead .grip{flex:none;}
#trade .fila{display:flex;gap:5px;align-items:center;margin-bottom:5px;}
#trade button{cursor:pointer;border:0;border-radius:5px;color:#fff;font-weight:800;font-size:12px;padding:7px 4px;flex:1;}
#bV{background:#b91c1c;} #bC{background:#15803d;}
#trade input{width:100%;box-sizing:border-box;background:#0e141b;border:1px solid #33404d;border-radius:5px;color:#f4f1e8;padding:5px;font-size:12px;}
#trade label{flex:1;display:flex;flex-direction:column;gap:2px;color:#8893a0;font-size:10px;}
#cuerpo.oculto{display:none;}
#bTog{flex:1;width:auto;background:#1d2530;color:#dce2e8;}
#resumen{color:#8893a0;font-size:11px;margin:4px 0;}
.op{border-top:1px solid #26303b;padding:5px 0;display:flex;flex-wrap:wrap;gap:4px;align-items:center;}
.op small{color:#8893a0;width:100%;font-size:10px;}
.op button{flex:none;padding:3px 6px;background:#303b48;font-size:11px;}
#borrarOps{background:#3a2024;margin-top:4px;width:100%;}
#trade label.chk{flex-direction:row;align-items:center;gap:5px;color:#c9d1d9;font-size:11px;}
#trade .chk input{width:auto;}
#drawer{left:6px;right:68px;bottom:32px;max-height:50%;display:flex;flex-direction:column;}
#dBar{display:flex;align-items:center;gap:8px;padding:4px 6px;font-size:11px;color:#c9d1d9;flex-wrap:wrap;}
#dBar button{border:1px solid #33404d;background:#1d2530;color:#dce2e8;border-radius:5px;font-size:11px;padding:3px 8px;cursor:pointer;}
#dBar button.on{background:#b88b35;color:#0b0f14;border-color:#b88b35;}
#dBody{overflow:auto;border-top:1px solid #26303b;}
#drawer.max{top:6px;left:6px;right:6px;bottom:6px;max-height:none;z-index:40;background:rgba(15,20,27,.98);}
#drawer.max #dBody{flex:1;}
#drawer.max #tbl{font-size:13px;}
#drawer.max #tbl td,#drawer.max #tbl th{padding:6px 10px;}
#dBody.oculto{display:none;}
#tbl{width:100%;border-collapse:collapse;font-size:11px;}
#tbl th{position:sticky;top:0;background:#151b23;color:#8893a0;text-align:left;padding:3px 6px;font-weight:600;}
#tbl td{padding:3px 6px;border-top:1px solid #1f2933;white-space:nowrap;}
#toast{position:absolute;z-index:20;left:50%;bottom:34px;transform:translateX(-50%);background:#111827;border:1px solid #33404d;color:#f4f1e8;padding:7px 12px;border-radius:6px;font-size:12px;display:none;white-space:nowrap;}
</style>
</head><body>
<div id="wrap">
<div id="chart"></div>
<canvas id="cv"></canvas>
<select id="tz" title="Horario del eje: desplazamiento respecto a la hora del servidor MT5"></select>
<div id="tools" class="panel">
  <span class="grip keep" id="gTools" title="Arrastra para mover">&#8942;&#8942;</span>
  <button id="tMin" class="keep" title="Minimizar / expandir herramientas">&#8211;</button>
  <button data-m="cursor" title="Cursor / seleccionar">&#10011;</button>
  <button data-m="h" title="Linea horizontal">&#9472;</button>
  <button data-m="tl" title="Linea de tendencia">&#9585;</button>
  <button data-m="ray" title="Rayo">&#8599;</button>
  <button data-m="rect" title="Rectangulo">&#9645;</button>
  <button data-m="fib" title="Fibonacci">Fib</button>
  <button data-m="medir" title="Medir">&#128207;</button>
  <button data-m="poli" title="Polilinea: toca varios puntos; doble toque o Enter para terminar">Poli</button>
  <button data-m="ruta" title="Ruta con flecha: toca varios puntos; doble toque o Enter para terminar">Ruta</button>
  <div id="sep"></div>
  <button id="bColor" title="Color">&#9679;</button>
  <button id="bUndo" title="Deshacer ultimo dibujo">&#8630;</button>
  <button id="bDel" title="Borrar el dibujo seleccionado">&#128465;</button>
  <button id="bClear" title="Borrar todos los dibujos">&#10005;</button>
  <button id="bTipo" title="Cambiar entre velas y grafico lineal">Linea</button>
  <button id="bBot" class="keep" title="Operaciones del bot en el grafico: todo / solo marcas / ocultas">Bot</button>
</div>
<div id="trade" class="panel">
  <div id="tHead"><span class="grip" id="gTrade" title="Arrastra para mover">&#8942;&#8942;</span><button id="bTog" title="Minimizar / expandir">&#9662; Operar</button></div>
  <div id="cuerpo">
    <div class="fila" style="margin-top:6px"><button id="bV">VENDER</button><button id="bC">COMPRAR</button></div>
    <div class="fila">
      <label>Lote<input id="iLote" inputmode="decimal" /></label>
      <label>SL (dist.)<input id="iSL" inputmode="decimal" /></label>
      <label>TP (dist.)<input id="iTP" inputmode="decimal" /></label>
    </div>
    <div class="fila"><label class="chk"><input type="checkbox" id="cGraf" /> Poner SL/TP tocando el grafico</label></div>
    <div id="resumen"></div>
    <div id="pos"></div>
    <button id="borrarOps">Borrar operaciones manuales</button>
  </div>
</div>
<div id="drawer" class="panel">
  <div id="dBar">
    <button id="dTog">&#9652; Operaciones</button>
    <button data-tab="ab" class="on">Abiertas</button>
    <button data-tab="hi">Historial</button>
    <button id="dTodo" title="Mostrar todas las operaciones (sin el limite de 40)">Ver todo</button>
    <button id="dMax" title="Agrandar la tabla a toda la pantalla (Esc para volver)">&#9974; Pantalla completa</button>
    <span id="dRes"></span>
  </div>
  <div id="dBody" class="oculto"></div>
</div>
<div id="toast"></div>
</div>
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
<script>
(function () {
  var TODAS_VELAS = ${JSON.stringify(velas)};
  var TODAS_OPS = ${JSON.stringify(ops)};
  var PASOS_ESTRATEGIA = ${pasosSeguros};
  var ESTADO_INICIAL = ${estadoSeguro};
  var CONTRATO = ${contrato};
  var V = TODAS_VELAS;
  var N = V.length;

  // ---------- estado manual ----------
  var estado = ESTADO_INICIAL || {};
  if (!estado.dibujos) estado.dibujos = [];
  if (!estado.trades) estado.trades = [];
  if (!estado.sig) estado.sig = 1;
  if (!estado.cfg) estado.cfg = {};
  var cfg = estado.cfg;
  var COLORES = ['#f5c542', '#38bdf8', '#f472b6', '#a78bfa', '#ffffff', '#fb923c'];
  var refPrecio = N ? V[N - 1].close : 1;
  var DEC = refPrecio > 500 ? 2 : (refPrecio > 50 ? 3 : 5);
  function fmt(p) { return Number(p).toFixed(DEC); }
  function sg(x) { return (x >= 0 ? '+' : '') + x.toFixed(2); }
  var TZ = (Number(cfg.tz) || 0) * 3600; // replay2-v1
  if (!cfg.lote) cfg.lote = 0.01;
  if (!cfg.color) cfg.color = COLORES[0];
  if (cfg.toolsMin === undefined) cfg.toolsMin = true; // replay-limpio
  if (!cfg.sl) cfg.sl = Number((refPrecio * 0.001).toFixed(DEC));
  if (!cfg.tp) cfg.tp = Number((refPrecio * 0.002).toFixed(DEC));

  function guardar() {
    var copia = {
      dibujos: estado.dibujos,
      trades: estado.trades.map(function (t) { var c = {}; for (var k in t) { if (k !== '_res') c[k] = t[k]; } return c; }),
      sig: estado.sig,
      cfg: cfg,
    };
    var s = JSON.stringify(copia);
    try {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'estadoReplay', estado: s }));
      else window.parent.postMessage({ type: 'estadoReplay', estado: s }, '*');
    } catch (e) {}
  }

  // ---------- grafico ----------
  var chart = LightweightCharts.createChart(document.getElementById('chart'), {
    layout: { background: { color: '#0b0f14' }, textColor: '#d1d8e0' },
    grid: { vertLines: { color: '#0f151b' }, horzLines: { color: '#0f151b' } },
    rightPriceScale: { borderColor: '#222c37' },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#222c37' },
    width: window.innerWidth,
    height: window.innerHeight,
  });
  var serie = chart.addCandlestickSeries({
    upColor: '#22c55e', downColor: '#ef4444', borderVisible: false,
    wickUpColor: '#22c55e', wickDownColor: '#ef4444',
  });
  var serieL = chart.addLineSeries({ color: '#38bdf8', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, visible: false });
  var lineasOperacion = [];
  var lineasManual = [];
  var lineasEstrategia = [];

  function limpiarLineasOperacion() {
    for (var k = 0; k < lineasOperacion.length; k++) serie.removePriceLine(lineasOperacion[k]);
    lineasOperacion = [];
  }
  function linea(precio, color, texto, estilo) {
    if (!precio) return;
    lineasOperacion.push(serie.createPriceLine({ price: precio, color: color, lineWidth: 2, lineStyle: estilo || 0, axisLabelVisible: true, title: texto }));
  }
  function lineaManual(precio, color, texto, estilo) {
    if (!precio) return;
    lineasManual.push(serie.createPriceLine({ price: precio, color: color, lineWidth: 1, lineStyle: estilo || 0, axisLabelVisible: true, title: texto }));
  }
  function lineaEstrategia(precio, color, texto) {
    if (precio === null || precio === undefined || !Number.isFinite(Number(precio))) return;
    lineasEstrategia.push(serie.createPriceLine({ price: Number(precio), color: color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: texto }));
  }

  // ---------- tiempo <-> indice logico (permite dibujar hacia el futuro) ----------
  function idxHasta(t) {
    var lo = 0, hi = N - 1, r = -1;
    while (lo <= hi) {
      var m = (lo + hi) >> 1;
      if (V[m].time <= t) { r = m; lo = m + 1; } else { hi = m - 1; }
    }
    return r;
  }
  var paso = (function () {
    var d = [];
    var lim = Math.min(N - 1, 300);
    for (var i = 0; i < lim; i++) { var x = V[i + 1].time - V[i].time; if (x > 0) d.push(x); }
    d.sort(function (a, b) { return a - b; });
    return d.length ? d[d.length >> 1] : 60;
  })();
  function tToL(t) {
    if (!N) return 0;
    var i = idxHasta(t);
    if (i < 0) return (t - V[0].time) / paso;
    if (i >= N - 1) return (N - 1) + (t - V[N - 1].time) / paso;
    return i + (t - V[i].time) / (V[i + 1].time - V[i].time);
  }
  function lToT(l) {
    if (!N) return 0;
    if (l <= 0) return V[0].time + l * paso;
    if (l >= N - 1) return V[N - 1].time + (l - (N - 1)) * paso;
    var i = Math.floor(l);
    return V[i].time + (l - i) * (V[i + 1].time - V[i].time);
  }
  function X(t) { return chart.timeScale().logicalToCoordinate(tToL(t)); }
  function Y(p) { return serie.priceToCoordinate(p); }
  function pt(o) { var x = X(o.t), y = Y(o.p); if (x === null || y === null) return null; return { x: x, y: y }; }
  function puntoDe(x, y) {
    var l = chart.timeScale().coordinateToLogical(x);
    var p = serie.coordinateToPrice(y);
    if (l === null || p === null) return null;
    return { t: Math.round(lToT(l)), p: p };
  }

  // ---------- operaciones manuales ----------
  function nivelesEn(tr, t) {
    var h = tr.hist, r = h[0];
    for (var i = 1; i < h.length; i++) { if (h[i].t <= t) r = h[i]; }
    return r;
  }
  function resolver(tr) {
    if (tr._res !== undefined) return tr._res;
    if (tr.fijo) {
      tr._res = { idx: Math.max(idxHasta(tr.t), idxHasta(tr.fijo.t)), precio: tr.fijo.precio, motivo: tr.fijo.motivo };
      return tr._res;
    }
    var i0 = idxHasta(tr.t);
    var res = null;
    if (i0 < 0) { tr._res = null; return null; }
    var dir = tr.tipo === 'compra' ? 1 : -1;
    var hi = 0;
    for (var i = i0 + 1; i < N; i++) {
      var v = V[i];
      if (tr.cierre && v.time > tr.cierre.t) break;
      while (hi + 1 < tr.hist.length && tr.hist[hi + 1].t < v.time) hi++;
      var lv = tr.hist[hi];
      if (dir === 1) {
        if (lv.sl && v.low <= lv.sl) { res = { idx: i, precio: Math.min(lv.sl, v.open), motivo: 'sl' }; break; }
        if (lv.tp && v.high >= lv.tp) { res = { idx: i, precio: lv.tp, motivo: 'tp' }; break; }
      } else {
        if (lv.sl && v.high >= lv.sl) { res = { idx: i, precio: Math.max(lv.sl, v.open), motivo: 'sl' }; break; }
        if (lv.tp && v.low <= lv.tp) { res = { idx: i, precio: lv.tp, motivo: 'tp' }; break; }
      }
    }
    if (!res && tr.cierre) res = { idx: Math.max(i0, idxHasta(tr.cierre.t)), precio: tr.cierre.precio, motivo: 'manual' };
    tr._res = res;
    return res;
  }
  function plDe(tr, precio) {
    var dir = tr.tipo === 'compra' ? 1 : -1;
    return (precio - tr.entrada) * dir * tr.lote * CONTRATO;
  }
  function estadoTrade(tr, n) {
    var i0 = idxHasta(tr.t);
    if (n < 1 || i0 < 0 || n - 1 < i0) return { e: 'futuro', pl: 0 };
    var res = resolver(tr);
    if (res && res.idx <= n - 1) return { e: 'cerrada', res: res, pl: tr.fijo ? tr.fijo.profit : plDe(tr, res.precio) };
    return { e: 'abierta', pl: plDe(tr, V[n - 1].close) };
  }

  var botTrades = TODAS_OPS.map(function (op, i) {
    return {
      id: 'B' + (i + 1), origen: 'bot', tipo: op.tipo, t: op.aperturaEpoch, entrada: op.entrada,
      lote: op.volumen > 0 ? op.volumen : 0.01,
      hist: [{ t: op.aperturaEpoch, sl: op.sl, tp: op.tp }],
      fijo: { t: op.cierreEpoch, precio: op.salida, motivo: op.motivoCierre, profit: op.profit },
    };
  });
  function todas() { return botTrades.concat(estado.trades); }
  function esBot(tr) { return tr.origen === 'bot'; }
  function dosd(x) { return (x < 10 ? '0' : '') + x; }
  function hora(t) {
    var d = new Date((t + TZ) * 1000);
    return d.getUTCFullYear() + '.' + dosd(d.getUTCMonth() + 1) + '.' + dosd(d.getUTCDate()) + ' ' + dosd(d.getUTCHours()) + ':' + dosd(d.getUTCMinutes());
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 2600);
  }

  function leerCfg() {
    var l = parseFloat(String(document.getElementById('iLote').value).replace(',', '.'));
    var s = parseFloat(String(document.getElementById('iSL').value).replace(',', '.'));
    var t = parseFloat(String(document.getElementById('iTP').value).replace(',', '.'));
    if (l > 0) cfg.lote = l;
    cfg.sl = s > 0 ? s : 0;
    cfg.tp = t > 0 ? t : 0;
    cfg.graf = document.getElementById('cGraf').checked;
  }

  function operar(tipo) {
    var n = window.indiceActual || 0;
    if (!n) return;
    leerCfg();
    var v = V[n - 1];
    var dir = tipo === 'compra' ? 1 : -1;
    var entrada = v.close;
    var sl = !cfg.graf && cfg.sl > 0 ? Number((entrada - dir * cfg.sl).toFixed(DEC)) : 0;
    var tp = !cfg.graf && cfg.tp > 0 ? Number((entrada + dir * cfg.tp).toFixed(DEC)) : 0;
    var tr = { id: estado.sig++, origen: 'manual', tipo: tipo, t: v.time, entrada: entrada, lote: cfg.lote, hist: [{ t: v.time, sl: sl, tp: tp }] };
    estado.trades.push(tr);
    guardar();
    refrescar(null);
    if (cfg.graf) {
      ajuste = { id: tr.id, que: 'sl', cadena: true };
      setModo('ajuste');
      toast((tipo === 'compra' ? 'COMPRA' : 'VENTA') + ' abierta. Toca el grafico donde va el SL (toca el cursor para cancelar)');
    } else {
      toast((tipo === 'compra' ? 'COMPRA' : 'VENTA') + ' ' + cfg.lote + ' @ ' + fmt(entrada));
    }
  }

  function cerrarManual(id) {
    var n = window.indiceActual || 0;
    for (var i = 0; i < estado.trades.length; i++) {
      var tr = estado.trades[i];
      if (tr.id === id && n) {
        tr.cierre = { t: V[n - 1].time, precio: V[n - 1].close };
        tr._res = undefined;
        guardar();
        refrescar(null);
        toast('Cerrada ' + sg(plDe(tr, tr.cierre.precio)));
      }
    }
  }

  var ajuste = null;
  function aplicarAjuste(precio) {
    var n = window.indiceActual || 0;
    if (!n || !ajuste) return;
    var tr = null;
    for (var i = 0; i < estado.trades.length; i++) { if (estado.trades[i].id === ajuste.id) tr = estado.trades[i]; }
    if (!tr) { setModo('cursor'); return; }
    var cierre = V[n - 1].close;
    var dir = tr.tipo === 'compra' ? 1 : -1;
    var p = Number(precio.toFixed(DEC));
    if (ajuste.que === 'sl' && (p - cierre) * dir >= 0) { toast('El SL tiene que quedar del lado de la perdida'); return; }
    if (ajuste.que === 'tp' && (p - cierre) * dir <= 0) { toast('El TP tiene que quedar del lado de la ganancia'); return; }
    var lv = nivelesEn(tr, V[n - 1].time);
    var nuevo = { t: V[n - 1].time, sl: lv.sl, tp: lv.tp };
    nuevo[ajuste.que] = p;
    var ult = tr.hist[tr.hist.length - 1];
    if (ult.t === nuevo.t) tr.hist[tr.hist.length - 1] = nuevo; else tr.hist.push(nuevo);
    tr._res = undefined;
    var q = ajuste.que, cad = ajuste.cadena;
    guardar();
    refrescar(null);
    if (q === 'sl' && cad) {
      ajuste = { id: tr.id, que: 'tp', cadena: false };
      setModo('ajuste');
      toast('SL en ' + fmt(p) + '. Ahora toca donde va el TP');
    } else {
      ajuste = null;
      setModo('cursor');
      toast(q.toUpperCase() + ' en ' + fmt(p));
    }
  }

  var cerradasPrev = {};
  function marcadoresManuales(n) {
    var m = [];
    if (!n) return m;
    var tAct = V[n - 1].time;
    for (var i = 0; i < estado.trades.length; i++) {
      var tr = estado.trades[i];
      var i0 = idxHasta(tr.t);
      if (i0 < 0 || V[i0].time > tAct) continue;
      m.push({ time: V[i0].time, position: tr.tipo === 'compra' ? 'belowBar' : 'aboveBar', color: '#60a5fa', shape: tr.tipo === 'compra' ? 'arrowUp' : 'arrowDown', text: 'YO ' + (tr.tipo === 'compra' ? 'C' : 'V') });
      var est = estadoTrade(tr, n);
      if (est.e === 'cerrada') {
        m.push({ time: V[est.res.idx].time, position: tr.tipo === 'compra' ? 'aboveBar' : 'belowBar', color: est.pl >= 0 ? '#22c55e' : '#ef4444', shape: 'circle', text: est.res.motivo.toUpperCase() + ' ' + sg(est.pl) });
      }
    }
    return m;
  }

  function marcadoresHasta(i) {
    if (!i) return [];
    var tiempoActual = TODAS_VELAS[i - 1].time;
    var marcadores = [];
    for (var j = 0; j < TODAS_OPS.length; j++) {
      var op = TODAS_OPS[j];
      var tiempoEntrada = tiempoDeVelaAnterior(op.aperturaEpoch);
      var tiempoSalida = tiempoDeVelaAnterior(op.cierreEpoch);
      if (tiempoEntrada !== null && tiempoEntrada <= tiempoActual) {
        marcadores.push({ time: tiempoEntrada, position: 'belowBar', color: op.tipo === 'compra' ? '#22c55e' : '#ef4444', shape: op.tipo === 'compra' ? 'arrowUp' : 'arrowDown', text: '' });
      }
      if (tiempoSalida !== null && tiempoSalida <= tiempoActual) {
        var colorCierre = op.motivoCierre === 'tp' || (op.motivoCierre === 'be' && op.profit >= 0) ? '#22c55e' : '#ef4444';
        marcadores.push({ time: tiempoSalida, position: 'aboveBar', color: colorCierre, shape: 'circle', text: '' });
      }
    }
    return marcadores;
  }

  // Limpio: sin texto largo. Entrada = flecha + "C 0.09"; cierre = cuadro + "SL -91" / "TP +407".
  // Las lineas de zona/entrada/SL/TP ya cuentan el analisis; los puntos de analisis solo salen con zoom.
  function marcadoresEstrategia(n) {
    if (!n || modoBot() === 'oculto') return [];
    var rg = null;
    try { rg = chart.timeScale().getVisibleLogicalRange(); } catch (e) {}
    var visibles = rg ? (rg.to - rg.from) : 99999;
    var conTexto = modoBot() === 'todo' && visibles <= 140;
    var conPuntos = modoBot() === 'todo' && visibles <= 140;
    var hasta = V[n - 1].time;
    var porVela = {};
    for (var i = 0; i < PASOS_ESTRATEGIA.length; i++) {
      var paso = PASOS_ESTRATEGIA[i];
      if (paso.time > hasta) continue;
      var esOp = paso.tipo === 'entrada' || paso.tipo === 'cierre';
      if (!esOp && !conPuntos) continue;
      var indice = idxHasta(paso.time);
      if (indice < 0) continue;
      var tiempo = V[indice].time;
      var grupo = porVela[tiempo];
      if (grupo && grupo.esOp && !esOp) continue;
      if (grupo && !grupo.esOp && esOp) grupo = null;
      if (!grupo) grupo = { time: tiempo, position: 'aboveBar', color: '#e4b75a', shape: 'circle', text: '', esOp: esOp, size: 0.5 };
      var etiqueta = '';
      if (paso.tipo === 'entrada') {
        var bajista = paso.direccion === 'bajista';
        grupo.position = bajista ? 'aboveBar' : 'belowBar';
        grupo.color = bajista ? '#ef4444' : '#22c55e';
        grupo.shape = bajista ? 'arrowDown' : 'arrowUp';
        grupo.size = 1;
        var lot = '';
        var partes = String(paso.texto || '').split(' \u00b7 ');
        for (var k = 0; k < partes.length; k++) { if (partes[k].indexOf(' lotes') > 0) lot = partes[k].replace(' lotes', ''); }
        etiqueta = (bajista ? 'V ' : 'C ') + lot;
      } else if (paso.tipo === 'cierre') {
        var texto = String(paso.texto || '');
        var gan = texto.indexOf('TP') >= 0;
        grupo.color = gan ? '#22c55e' : '#ef4444';
        grupo.shape = 'square';
        grupo.size = 1;
        var pp = texto.split(' \u00b7 ');
        etiqueta = (gan ? 'TP ' : 'SL ') + pp[pp.length - 1];
      }
      grupo.text = conTexto ? etiqueta : '';
      porVela[tiempo] = grupo;
    }
    return Object.keys(porVela).map(function (t) { var g = porVela[t]; delete g.esOp; return g; });
  }

  function pintarMarcadores(n) {
    var marc = (modoBot() === 'oculto' ? [] : marcadoresHasta(n)).concat(marcadoresManuales(n), marcadoresEstrategia(n));
    marc.sort(function (a, b) { return a.time - b.time; });
    serie.setMarkers(marc);
  }
  var temporizadorZoom = null;
  chart.timeScale().subscribeVisibleLogicalRangeChange(function () {
    clearTimeout(temporizadorZoom);
    temporizadorZoom = setTimeout(function () { pintarMarcadores(window.indiceActual || 0); }, 150);
  });

  function tiempoDeVelaAnterior(epoch) {
    var r = idxHasta(epoch);
    return r < 0 ? null : V[r].time;
  }

  var drawerAbierto = false, tabDrawer = 'ab', ultAb = [], ultHi = [], verTodo = false, maximizado = false;
  function celdaPl(x) { return '<td style="color:' + (x >= 0 ? '#4ade80' : '#f87171') + ';font-weight:700">' + sg(x) + '</td>'; }
  function pintarTabla() {
    var body = document.getElementById('dBody');
    body.className = drawerAbierto ? '' : 'oculto';
    if (!drawerAbierto) return;
    var n = window.indiceActual || 0;
    var h = '';
    if (tabDrawer === 'ab') {
      h = '<table id="tbl"><tr><th>Origen</th><th>Tipo</th><th>Lote</th><th>Apertura</th><th>Entrada</th><th>S/L</th><th>T/P</th><th>Precio</th><th>Beneficio</th></tr>';
      for (var i = 0; i < ultAb.length; i++) {
        var tr = ultAb[i].tr, lv = nivelesEn(tr, V[n - 1].time);
        h += '<tr><td>' + (esBot(tr) ? 'Bot' : 'Manual') + '</td><td style="color:' + (tr.tipo === 'compra' ? '#4ade80' : '#f87171') + '">' + (tr.tipo === 'compra' ? 'buy' : 'sell') + '</td><td>' + tr.lote + '</td><td>' + hora(tr.t) + '</td><td>' + fmt(tr.entrada) + '</td><td>' + (lv.sl ? fmt(lv.sl) : '-') + '</td><td>' + (lv.tp ? fmt(lv.tp) : '-') + '</td><td>' + fmt(V[n - 1].close) + '</td>' + celdaPl(ultAb[i].est.pl) + '</tr>';
      }
      if (!ultAb.length) h += '<tr><td colspan="9" style="color:#8893a0">Sin operaciones abiertas</td></tr>';
    } else {
      ultHi.sort(function (a, b) { return b.est.res.idx - a.est.res.idx; });
      h = '<table id="tbl"><tr><th>Origen</th><th>Tipo</th><th>Lote</th><th>Apertura</th><th>Entrada</th><th>Salida</th><th>Motivo</th><th>Beneficio</th></tr>';
      var lim = verTodo ? ultHi.length : Math.min(ultHi.length, 40);
      for (var j = 0; j < lim; j++) {
        var t2 = ultHi[j].tr, e2 = ultHi[j].est;
        h += '<tr><td>' + (esBot(t2) ? 'Bot' : 'Manual') + '</td><td style="color:' + (t2.tipo === 'compra' ? '#4ade80' : '#f87171') + '">' + (t2.tipo === 'compra' ? 'buy' : 'sell') + '</td><td>' + t2.lote + '</td><td>' + hora(t2.t) + '</td><td>' + fmt(t2.entrada) + '</td><td>' + fmt(e2.res.precio) + '</td><td>' + e2.res.motivo.toUpperCase() + '</td>' + celdaPl(e2.pl) + '</tr>';
      }
      if (!ultHi.length) h += '<tr><td colspan="8" style="color:#8893a0">Todavia no hay operaciones cerradas</td></tr>';
      if (ultHi.length > lim) h += '<tr><td colspan="8" style="color:#8893a0">... y ' + (ultHi.length - lim) + ' mas antiguas (toca Ver todo)</td></tr>';
    }
    body.innerHTML = h + '</table>';
  }

  // Panel de posiciones + lineas de precio + marcadores + tabla. previo != null => avance de replay (permite avisos TP/SL).
  function refrescar(previo) {
    var n = window.indiceActual || 0;
    for (var k = 0; k < lineasManual.length; k++) serie.removePriceLine(lineasManual[k]);
    lineasManual = [];
    for (var e = 0; e < lineasEstrategia.length; e++) serie.removePriceLine(lineasEstrategia[e]);
    lineasEstrategia = [];
    var html = '';
    var cT = 0, nT = 0, fT = 0, cM = 0, gM = 0, nM = 0, fM = 0;
    var abiertas = [], hist = [];
    var lista = todas();
    for (var i = 0; i < lista.length; i++) {
      var tr = lista[i];
      var est = estadoTrade(tr, n);
      var man = !esBot(tr);
      if (est.e === 'cerrada') {
        cT++; nT += est.pl; hist.push({ tr: tr, est: est });
        if (man) { cM++; nM += est.pl; if (est.pl > 0) gM++; }
        if (previo !== null && n > previo && n - previo <= 50 && !cerradasPrev[tr.id]) {
          toast((man ? '' : 'BOT ') + est.res.motivo.toUpperCase() + ' alcanzado ' + sg(est.pl));
        }
      }
      cerradasPrev[tr.id] = est.e === 'cerrada';
      if (est.e !== 'abierta') continue;
      fT += est.pl; if (man) fM += est.pl;
      abiertas.push({ tr: tr, est: est });
      var lv = nivelesEn(tr, V[n - 1].time);
      var pre = man ? '' : 'BOT ';
      if (man || modoBot() === 'todo') {
        lineaManual(tr.entrada, '#3b82f6', pre + (tr.tipo === 'compra' ? 'BUY' : 'SELL'), 0);
        lineaManual(lv.sl, '#ef4444', pre + 'SL', 2);
        lineaManual(lv.tp, '#22c55e', pre + 'TP', 2);
      }
      if (man) {
        html += '<div class="op"><b style="color:' + (tr.tipo === 'compra' ? '#4ade80' : '#f87171') + '">' + (tr.tipo === 'compra' ? 'COMPRA' : 'VENTA') + '</b> ' + tr.lote +
          ' <b style="color:' + (est.pl >= 0 ? '#4ade80' : '#f87171') + '">' + sg(est.pl) + '</b>' +
          '<button data-a="sl" data-id="' + tr.id + '">SL</button><button data-a="tp" data-id="' + tr.id + '">TP</button><button data-a="x" data-id="' + tr.id + '">Cerrar</button>' +
          '<small>Entrada ' + fmt(tr.entrada) + ' | SL ' + (lv.sl ? fmt(lv.sl) : '-') + ' | TP ' + (lv.tp ? fmt(lv.tp) : '-') + '</small></div>';
      }
    }
    ultAb = abiertas; ultHi = hist;
    document.getElementById('pos').innerHTML = html;
    document.getElementById('resumen').textContent = 'Manual: cerradas ' + cM + (cM ? ' (' + gM + ' ganadas)' : '') + ' | Neto ' + sg(nM) + ' | Flotante ' + sg(fM);
    document.getElementById('dRes').textContent = abiertas.length + ' abiertas | Flotante ' + sg(fT) + ' | Cerradas ' + cT + ' | Neto ' + sg(nT);
    pintarTabla();
    var tiempoActual = n ? V[n - 1].time : 0;
    var escenarios = {};
    for (var p = 0; p < PASOS_ESTRATEGIA.length; p++) {
      var paso = PASOS_ESTRATEGIA[p];
      if (paso.time > tiempoActual || !paso.escenario_id) continue;
      escenarios[paso.escenario_id] = paso;
    }
    Object.keys(escenarios).forEach(function (id) {
      var paso = escenarios[id];
      if (!paso.activo) return;
      if (paso.zona_rango && paso.zona_rango.length === 2) {
        lineaEstrategia(paso.zona_rango[0], '#e4b75a', 'Zona ' + (paso.zona || ''));
        lineaEstrategia(paso.zona_rango[1], '#e4b75a', 'Zona ' + (paso.zona || ''));
      }
      lineaEstrategia(paso.entrada, '#60a5fa', 'Entrada estrategia');
      lineaEstrategia(paso.sl, '#ef4444', 'SL estrategia');
      lineaEstrategia(paso.tp, '#22c55e', 'TP estrategia');
    });
    pintarMarcadores(n);
  }

  // ---------- dibujos ----------
  var modo = 'cursor';
  var pendiente = null;
  var cursorPt = null;
  var seleccion = null;
  var NIVELES_FIB = [0, 0.236, 0.27, 0.382, 0.5, 0.618, 0.786, 0.886, 1, 1.1, 1.27, 1.38, 1.618, 2, 2.618];
  var NIV_EST = [0.27, 0.382, 0.5, 0.886, 1.1, 1.27, 1.38];  // los que usa la estrategia
  var pendPts = [];
  var ultTapPoli = 0;
  function cerrarPoli() {
    if ((modo === 'poli' || modo === 'ruta') && pendPts.length >= 2) {
      agregar({ tipo: modo, p1: pendPts[0], p2: pendPts[pendPts.length - 1], pts: pendPts.slice() });
    }
    pendPts = [];
  }
  function dibujarPoli(pts, c, ancho, flecha, sel, cursor) {
    var ps = [];
    for (var i = 0; i < pts.length; i++) { var q = pt(pts[i]); if (q) ps.push(q); }
    if (cursor) { var qc = pt(cursor); if (qc) ps.push(qc); }
    for (var j = 1; j < ps.length; j++) trazo(ps[j - 1].x, ps[j - 1].y, ps[j].x, ps[j].y, c, ancho);
    if (flecha && ps.length >= 2) {
      var e = ps[ps.length - 1], s0 = ps[ps.length - 2];
      var ang = Math.atan2(e.y - s0.y, e.x - s0.x), L = 12;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.x - L * Math.cos(ang - 0.45), e.y - L * Math.sin(ang - 0.45));
      ctx.lineTo(e.x - L * Math.cos(ang + 0.45), e.y - L * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fill();
    }
    if (sel || cursor) { for (var k = 0; k < ps.length; k++) punto(ps[k].x, ps[k].y, c); }
  }

  function setModo(m) {
    cerrarPoli();
    modo = m;
    if (m === 'poli' || m === 'ruta') toast('Toca varios puntos. Doble toque o Enter para terminar, Escape para cancelar.');
    pendiente = null;
    var bs = document.querySelectorAll('#tools button[data-m]');
    for (var i = 0; i < bs.length; i++) {
      if (bs[i].getAttribute('data-m') === m) bs[i].className = 'on'; else bs[i].className = '';
    }
  }
  function agregar(d) {
    d.id = estado.sig++;
    d.color = cfg.color;
    if (d.tipo === 'medir') {
      estado.dibujos = estado.dibujos.filter(function (x) { return x.tipo !== 'medir'; });
    }
    estado.dibujos.push(d);
    seleccion = d.id;
    guardar();
  }
  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function puntaRayo(a, b) {
    var dx = b.x - a.x;
    if (Math.abs(dx) < 0.5) return { x: a.x, y: b.y > a.y ? 100000 : -100000 };
    var xf = dx > 0 ? 100000 : -100000;
    var k = (xf - a.x) / dx;
    return { x: xf, y: a.y + k * (b.y - a.y) };
  }
  function dist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = ax + t * dx, cy = ay + t * dy;
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
  }
  function golpe(x, y) {
    for (var i = estado.dibujos.length - 1; i >= 0; i--) {
      var d = estado.dibujos[i];
      var a = pt(d.p1);
      var b = d.p2 ? pt(d.p2) : null;
      if (!a) continue;
      if (d.tipo === 'h') { if (Math.abs(y - a.y) < 10) return d.id; continue; }
      if (!b) continue;
      if ((d.tipo === 'poli' || d.tipo === 'ruta') && d.pts) {
        for (var q = 1; q < d.pts.length; q++) {
          var q0 = pt(d.pts[q - 1]), q1 = pt(d.pts[q]);
          if (q0 && q1 && dist(x, y, q0.x, q0.y, q1.x, q1.y) < 10) return d.id;
        }
        continue;
      }
      if (d.tipo === 'tl') { if (dist(x, y, a.x, a.y, b.x, b.y) < 10) return d.id; }
      else if (d.tipo === 'ray') { var f = puntaRayo(a, b); if (dist(x, y, a.x, a.y, f.x, f.y) < 10) return d.id; }
      else if (d.tipo === 'rect' || d.tipo === 'medir') {
        if (x >= Math.min(a.x, b.x) - 6 && x <= Math.max(a.x, b.x) + 6 && y >= Math.min(a.y, b.y) - 6 && y <= Math.max(a.y, b.y) + 6) return d.id;
      } else if (d.tipo === 'fib') {
        var x1 = Math.min(a.x, b.x) - 6, x2 = Math.max(a.x, b.x) + 6;
        if (x >= x1 && x <= x2) {
          for (var j = 0; j < NIVELES_FIB.length; j++) {
            var yy = Y(d.p2.p + (d.p1.p - d.p2.p) * NIVELES_FIB[j]);
            if (yy !== null && Math.abs(y - yy) < 8) return d.id;
          }
        }
      }
    }
    return null;
  }

  var cv = document.getElementById('cv');
  var ctx = cv.getContext('2d');
  var anchoEscala = 60, altoEscala = 28;
  function medidas() {
    try { var w = chart.priceScale('right').width(); if (w > 0) anchoEscala = w; } catch (e) {}
    try { var h = chart.timeScale().height(); if (h > 0) altoEscala = h; } catch (e) {}
    var tzEl = document.getElementById('tz');
    if (tzEl && (tzEl._w !== anchoEscala || tzEl._h !== altoEscala)) { tzEl._w = anchoEscala; tzEl._h = altoEscala; tzEl.style.width = anchoEscala + 'px'; tzEl.style.height = altoEscala + 'px'; }
  }
  function ajustarCanvas() {
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(window.innerWidth * dpr);
    cv.height = Math.floor(window.innerHeight * dpr);
    cv.style.width = window.innerWidth + 'px';
    cv.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function trazo(ax, ay, bx, by, color, ancho, dash) {
    ctx.beginPath();
    ctx.setLineDash(dash || []);
    ctx.strokeStyle = color;
    ctx.lineWidth = ancho;
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function etiqueta(txt, x, y, color, fondo, alinea) {
    ctx.font = '11px system-ui,Arial';
    var w = ctx.measureText(txt).width + 8;
    var xx = alinea === 'right' ? x - w : (alinea === 'center' ? x - w / 2 : x);
    ctx.fillStyle = fondo;
    ctx.fillRect(xx, y - 8, w, 16);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(txt, xx + 4, y);
  }
  function punto(x, y, c) {
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0f14';
    ctx.fill();
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function dibujarUno(d, sel, pw) {
    var a = pt(d.p1);
    if (!a) return;
    var b = d.p2 ? pt(d.p2) : null;
    var c = d.color || '#f5c542';
    var ancho = sel ? 3 : 1.6;
    if ((d.tipo === 'poli' || d.tipo === 'ruta') && d.pts) { dibujarPoli(d.pts, c, ancho, d.tipo === 'ruta', sel); return; }
    if (d.tipo === 'h') {
      trazo(0, a.y, pw, a.y, c, ancho);
      etiqueta(fmt(d.p1.p), pw - 2, a.y - 10, '#0b0f14', c, 'right');
      if (sel) punto(Math.min(pw - 20, Math.max(20, a.x)), a.y, c);
      return;
    }
    if (!b) return;
    if (d.tipo === 'tl') {
      trazo(a.x, a.y, b.x, b.y, c, ancho);
    } else if (d.tipo === 'ray') {
      var f = puntaRayo(a, b);
      trazo(a.x, a.y, f.x, f.y, c, ancho);
    } else if (d.tipo === 'rect') {
      ctx.fillStyle = rgba(c, 0.15);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.strokeStyle = c;
      ctx.lineWidth = ancho;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (d.tipo === 'fib') {
      var x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
      if (x2 - x1 < 40) x2 = x1 + 40;
      trazo(a.x, a.y, b.x, b.y, c, 1, [4, 4]);
      var prev = null;
      for (var i = 0; i < NIVELES_FIB.length; i++) {
        var pr = d.p2.p + (d.p1.p - d.p2.p) * NIVELES_FIB[i];
        var yy = Y(pr);
        if (yy === null) continue;
        if (prev !== null) {
          ctx.fillStyle = rgba(c, i % 2 ? 0.05 : 0.09);
          ctx.fillRect(x1, Math.min(prev, yy), x2 - x1, Math.abs(yy - prev));
        }
        trazo(x1, yy, x2, yy, c, sel ? 2 : (NIV_EST.indexOf(NIVELES_FIB[i]) >= 0 ? 1.6 : 0.8));
        etiqueta((NIVELES_FIB[i] * 100).toFixed(1) + '%  ' + fmt(pr), x1 + 2, yy - 9, '#0b0f14', c, 'left');
        prev = yy;
      }
    } else if (d.tipo === 'medir') {
      var sube = d.p2.p >= d.p1.p;
      var col = sube ? '#22c55e' : '#ef4444';
      ctx.fillStyle = rgba(col, 0.15);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      trazo(a.x, a.y, b.x, b.y, col, 1.5, [4, 3]);
      var diff = d.p2.p - d.p1.p;
      var pct = diff / d.p1.p * 100;
      var nv = Math.round(tToL(d.p2.t) - tToL(d.p1.t));
      etiqueta((diff >= 0 ? '+' : '') + fmt(diff) + '  (' + pct.toFixed(2) + '%)  ' + Math.abs(nv) + ' velas', (a.x + b.x) / 2, sube ? Math.min(a.y, b.y) - 14 : Math.max(a.y, b.y) + 14, '#ffffff', col, 'center');
    }
    if (sel) { punto(a.x, a.y, c); punto(b.x, b.y, c); }
  }

  function dibujarTrades(pw) {
    var n = window.indiceActual || 0;
    if (!n) return;
    var tAct = V[n - 1].time;
    var xAct = X(tAct);
    var rg = chart.timeScale().getVisibleLogicalRange();
    var muchas = !!(rg && (rg.to - rg.from) > 260);
    var lista = todas();
    for (var i = 0; i < lista.length; i++) {
      var tr = lista[i];
      if (esBot(tr) && modoBot() !== 'todo') continue;
      var est = estadoTrade(tr, n);
      if (est.e === 'futuro') continue;
      var i0 = idxHasta(tr.t);
      if (i0 < 0) continue;
      var cerrada = est.e === 'cerrada';
      var iFin = cerrada ? est.res.idx : n - 1;
      if (rg && (iFin < rg.from - 2 || i0 > rg.to + 2)) continue;
      var xe = X(V[i0].time);
      var xf = cerrada ? X(V[est.res.idx].time) : xAct;
      if (xe === null || xf === null) continue;
      if (!cerrada) xf += 30;
      var lv = nivelesEn(tr, cerrada ? V[est.res.idx].time : tAct);
      var ye = Y(tr.entrada);
      if (ye === null) continue;
      var ys = lv.sl ? Y(lv.sl) : null;
      var yt = lv.tp ? Y(lv.tp) : null;
      var alfa = cerrada ? 0.07 : 0.17;
      if (yt !== null) { ctx.fillStyle = rgba('#22c55e', alfa); ctx.fillRect(xe, Math.min(ye, yt), xf - xe, Math.abs(yt - ye)); }
      if (ys !== null) { ctx.fillStyle = rgba('#ef4444', alfa); ctx.fillRect(xe, Math.min(ye, ys), xf - xe, Math.abs(ys - ye)); }
      var pre = esBot(tr) ? 'BOT ' : '';
      if (cerrada) {
        trazo(xe, ye, xf, ye, '#3b82f6', 1);
        if (!muchas) etiqueta(pre + est.res.motivo.toUpperCase() + ' ' + sg(est.pl), xf, ye - 12, '#ffffff', est.pl >= 0 ? '#15803d' : '#b91c1c', 'right');
      } else {
        // etiquetas al estilo MT5, pegadas a la izquierda, con el beneficio en vivo
        etiqueta(pre + (tr.tipo === 'compra' ? 'BUY ' : 'SELL ') + tr.lote + ' @ ' + fmt(tr.entrada) + '   ' + sg(est.pl), 6, ye, '#ffffff', est.pl >= 0 ? '#15803d' : '#b91c1c', 'left');
        if (lv.sl && ys !== null) etiqueta('SL ' + fmt(lv.sl) + '   ' + sg(plDe(tr, lv.sl)), 6, ys, '#ffffff', '#7f1d1d', 'left');
        if (lv.tp && yt !== null) etiqueta('TP ' + fmt(lv.tp) + '   ' + sg(plDe(tr, lv.tp)), 6, yt, '#ffffff', '#14532d', 'left');
      }
    }
  }

  function dibujar() {
    medidas();
    var W = window.innerWidth, H = window.innerHeight;
    var pw = W - anchoEscala, ph = H - altoEscala;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pw, ph);
    ctx.clip();
    dibujarTrades(pw);
    for (var i = 0; i < estado.dibujos.length; i++) dibujarUno(estado.dibujos[i], estado.dibujos[i].id === seleccion, pw);
    if (modo !== 'cursor' && modo !== 'ajuste' && pendiente && cursorPt) {
      dibujarUno({ tipo: modo, p1: pendiente, p2: cursorPt, color: cfg.color }, false, pw);
    }
    if ((modo === 'poli' || modo === 'ruta') && pendPts.length) dibujarPoli(pendPts, cfg.color, 1.6, modo === 'ruta', false, cursorPt);
    if (modo === 'ajuste' && cursorPt) {
      var yc = Y(cursorPt.p);
      if (yc !== null) { trazo(0, yc, pw, yc, ajuste && ajuste.que === 'sl' ? '#ef4444' : '#22c55e', 1, [5, 4]); etiqueta(fmt(cursorPt.p), pw - 2, yc - 10, '#fff', '#334155', 'right'); }
    }
    ctx.restore();
    requestAnimationFrame(dibujar);
  }

  // ---------- interaccion (clicks del grafico: pan y zoom siguen funcionando) ----------
  // Los toques se detectan a mano: el grafico descarta un 2do clic que llegue en menos de ~0.5 s
  // (lo toma como doble clic), y para dibujar con 2 puntos eso pasaria seguido en el celular.
  function alTocar(x, y) {
    var W = window.innerWidth, H = window.innerHeight;
    if (x > W - anchoEscala || y > H - altoEscala) return;
    var p = puntoDe(x, y);
    if (!p) return;
    if (modo === 'cursor') { seleccion = golpe(x, y); return; }
    if (modo === 'ajuste') { aplicarAjuste(p.p); return; }
    if (modo === 'h') { agregar({ tipo: 'h', p1: p }); setModo('cursor'); return; }
    if (modo === 'poli' || modo === 'ruta') {
      var ahora = Date.now();
      var pa = pendPts.length ? pt(pendPts[pendPts.length - 1]) : null;
      if (pa && ahora - ultTapPoli < 450 && Math.abs(pa.x - x) < 14 && Math.abs(pa.y - y) < 14) { cerrarPoli(); setModo('cursor'); return; }
      pendPts.push(p); ultTapPoli = ahora; cursorPt = p;
      return;
    }
    if (!pendiente) { pendiente = p; cursorPt = p; return; }
    agregar({ tipo: modo, p1: pendiente, p2: p });
    setModo('cursor');
  }
  var elChart = document.getElementById('chart');
  var tapIni = null;
  elChart.addEventListener('pointerdown', function (e) {
    var r = elChart.getBoundingClientRect();
    tapIni = { x: e.clientX - r.left, y: e.clientY - r.top, t: Date.now() };
  }, true);
  elChart.addEventListener('pointerup', function (e) {
    if (!tapIni) return;
    var r = elChart.getBoundingClientRect();
    var x = e.clientX - r.left, y = e.clientY - r.top;
    var dx = x - tapIni.x, dy = y - tapIni.y, dt = Date.now() - tapIni.t;
    tapIni = null;
    if (dx * dx + dy * dy > 64 || dt > 600) return;
    alTocar(x, y);
  }, true);
  chart.subscribeCrosshairMove(function (param) {
    if (param && param.point) cursorPt = puntoDe(param.point.x, param.point.y);
  });

  var bsTool = document.querySelectorAll('#tools button[data-m]');
  for (var bi = 0; bi < bsTool.length; bi++) {
    bsTool[bi].addEventListener('click', function (e) {
      var m = e.currentTarget.getAttribute('data-m');
      if (modo === 'ajuste') ajuste = null;
      setModo(modo === m && m !== 'cursor' ? 'cursor' : m);
    });
  }
  var bColor = document.getElementById('bColor');
  function pintarColor() { bColor.style.color = cfg.color; }
  bColor.addEventListener('click', function () {
    var i = COLORES.indexOf(cfg.color);
    cfg.color = COLORES[(i + 1) % COLORES.length];
    if (seleccion !== null) {
      for (var k = 0; k < estado.dibujos.length; k++) { if (estado.dibujos[k].id === seleccion) estado.dibujos[k].color = cfg.color; }
    }
    pintarColor();
    guardar();
  });
  document.getElementById('bUndo').addEventListener('click', function () { estado.dibujos.pop(); seleccion = null; guardar(); });
  function borrarSeleccion() {
    if (seleccion === null) { toast('Toca un dibujo (con el cursor) para seleccionarlo'); return; }
    estado.dibujos = estado.dibujos.filter(function (d) { return d.id !== seleccion; });
    seleccion = null;
    guardar();
  }
  document.getElementById('bDel').addEventListener('click', borrarSeleccion);
  var limpiarTimer = null;
  var bClear = document.getElementById('bClear');
  bClear.addEventListener('click', function () {
    if (!limpiarTimer) {
      toast('Toca otra vez para borrar TODOS los dibujos');
      limpiarTimer = setTimeout(function () { limpiarTimer = null; }, 2500);
      return;
    }
    clearTimeout(limpiarTimer); limpiarTimer = null;
    estado.dibujos = []; seleccion = null; guardar();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { ajuste = null; setModo('cursor'); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && document.activeElement && document.activeElement.tagName !== 'INPUT') borrarSeleccion();
  });

  document.getElementById('bC').addEventListener('click', function () { operar('compra'); });
  document.getElementById('bV').addEventListener('click', function () { operar('venta'); });
  var iLote = document.getElementById('iLote'), iSL = document.getElementById('iSL'), iTP = document.getElementById('iTP');
  if (cfg.graf === undefined) cfg.graf = true;
  document.getElementById('cGraf').checked = !!cfg.graf;
  iLote.value = cfg.lote; iSL.value = cfg.sl; iTP.value = cfg.tp;
  [iLote, iSL, iTP, document.getElementById('cGraf')].forEach(function (el) { el.addEventListener('change', function () { leerCfg(); guardar(); }); });
  document.getElementById('pos').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    var id = Number(b.getAttribute('data-id'));
    var a = b.getAttribute('data-a');
    if (a === 'x') cerrarManual(id);
    else { ajuste = { id: id, que: a }; setModo('ajuste'); toast('Toca el grafico donde quieres el ' + a.toUpperCase() + ' (Esc cancela)'); }
  });
  var borrarTimer = null;
  document.getElementById('borrarOps').addEventListener('click', function () {
    if (!borrarTimer) {
      toast('Toca otra vez para borrar todas las operaciones manuales');
      borrarTimer = setTimeout(function () { borrarTimer = null; }, 2500);
      return;
    }
    clearTimeout(borrarTimer); borrarTimer = null;
    estado.trades = []; cerradasPrev = {}; guardar(); refrescar(null);
  });
  document.getElementById('dTog').addEventListener('click', function () {
    drawerAbierto = !drawerAbierto;
    document.getElementById('dTog').innerHTML = (drawerAbierto ? '&#9662; ' : '&#9652; ') + 'Operaciones';
    pintarTabla();
  });
  var tabsBtn = document.querySelectorAll('#dBar button[data-tab]');
  for (var ti = 0; ti < tabsBtn.length; ti++) {
    tabsBtn[ti].addEventListener('click', function (e) {
      tabDrawer = e.currentTarget.getAttribute('data-tab');
      for (var q = 0; q < tabsBtn.length; q++) tabsBtn[q].className = tabsBtn[q] === e.currentTarget ? 'on' : '';
      drawerAbierto = true;
      document.getElementById('dTog').innerHTML = '&#9662; Operaciones';
      pintarTabla();
    });
  }
  function pintarBotonesCajon() {
    var bt = document.getElementById('dTodo'), bm = document.getElementById('dMax');
    bt.className = verTodo ? 'on' : '';
    bt.innerHTML = verTodo ? 'Ver menos' : 'Ver todo';
    bm.className = maximizado ? 'on' : '';
    bm.innerHTML = maximizado ? '&#10005; Salir de pantalla completa' : '&#9974; Pantalla completa';
    document.getElementById('drawer').className = 'panel' + (maximizado ? ' max' : '');
  }
  document.getElementById('dTodo').addEventListener('click', function () {
    verTodo = !verTodo;
    drawerAbierto = true;
    document.getElementById('dTog').innerHTML = '&#9662; Operaciones';
    pintarBotonesCajon();
    pintarTabla();
  });
  function ponerMaximizado(v) {
    maximizado = v;
    if (v) {
      drawerAbierto = true;
      verTodo = true;
      document.getElementById('dTog').innerHTML = '&#9662; Operaciones';
    }
    pintarBotonesCajon();
    pintarTabla();
  }
  document.getElementById('dMax').addEventListener('click', function () { ponerMaximizado(!maximizado); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && maximizado) ponerMaximizado(false); });
  pintarBotonesCajon();
  if (!cfg.pos) cfg.pos = {};
  var cuerpoAbierto = cfg.tradeAbierto === undefined ? false : !!cfg.tradeAbierto;
  var panelTrade = document.getElementById('trade');
  var panelTools = document.getElementById('tools');
  function pintarPanel() {
    document.getElementById('cuerpo').className = cuerpoAbierto ? '' : 'oculto';
    document.getElementById('bTog').innerHTML = (cuerpoAbierto ? '&#9662; ' : '&#9656; ') + 'Operar';
    panelTrade.className = 'panel' + (cuerpoAbierto ? '' : ' mini');
    cfg.tradeAbierto = cuerpoAbierto;
  }
  document.getElementById('bTog').addEventListener('click', function () { cuerpoAbierto = !cuerpoAbierto; pintarPanel(); ponerEnLimites(panelTrade); guardar(); });
  pintarPanel();

  // ---------- paneles flotantes: arrastrables (mouse y tactil) y minimizables ----------
  function ponerEnLimites(el) {
    if (!el || !el.style.left) return;
    var W = window.innerWidth, H = window.innerHeight;
    var l = parseFloat(el.style.left) || 0, t = parseFloat(el.style.top) || 0;
    l = Math.max(0, Math.min(l, W - Math.min(el.offsetWidth, W) - 2));
    t = Math.max(0, Math.min(t, H - Math.min(el.offsetHeight, H) - 2));
    el.style.left = l + 'px'; el.style.top = t + 'px';
  }
  function hacerArrastrable(el, grip, clave) {
    var p = cfg.pos[clave];
    if (p && isFinite(p.l) && isFinite(p.t)) {
      el.style.left = p.l + 'px'; el.style.top = p.t + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto';
      ponerEnLimites(el);
    }
    var ini = null;
    grip.addEventListener('pointerdown', function (e) {
      var r = el.getBoundingClientRect();
      ini = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      el.style.left = r.left + 'px'; el.style.top = r.top + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto';
      el.classList.add('arrastrando');
      try { grip.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault();
    });
    grip.addEventListener('pointermove', function (e) {
      if (!ini) return;
      el.style.left = (e.clientX - ini.dx) + 'px';
      el.style.top = (e.clientY - ini.dy) + 'px';
      ponerEnLimites(el);
    });
    function soltar(e) {
      if (!ini) return;
      ini = null;
      el.classList.remove('arrastrando');
      try { grip.releasePointerCapture(e.pointerId); } catch (x) {}
      cfg.pos[clave] = { l: parseFloat(el.style.left) || 0, t: parseFloat(el.style.top) || 0 };
      guardar();
    }
    grip.addEventListener('pointerup', soltar);
    grip.addEventListener('pointercancel', soltar);
  }
  hacerArrastrable(panelTrade, document.getElementById('gTrade'), 'trade');
  hacerArrastrable(panelTools, document.getElementById('gTools'), 'tools');
  function pintarTools() {
    panelTools.className = 'panel' + (cfg.toolsMin ? ' mini' : '');
    document.getElementById('tMin').innerHTML = cfg.toolsMin ? '&#9998;' : '&#8211;';
    ponerEnLimites(panelTools);
  }
  document.getElementById('tMin').addEventListener('click', function () { cfg.toolsMin = !cfg.toolsMin; pintarTools(); guardar(); });
  pintarTools();
  window.addEventListener('resize', function () { ponerEnLimites(panelTrade); ponerEnLimites(panelTools); });
  pintarColor();
  setModo('cursor');

  function modoBot() { return cfg.verBot || 'todo'; }
  var bBot = document.getElementById('bBot');
  function pintarBot() {
    var m = modoBot();
    bBot.innerHTML = 'Bot ' + (m === 'todo' ? '&#9679;' : (m === 'marcas' ? '&#9680;' : '&#9675;'));
    bBot.className = 'keep' + (m === 'oculto' ? '' : ' on');
    bBot.title = 'Operaciones del bot: ' + (m === 'todo' ? 'TODO (cajas, lineas y etiquetas)' : (m === 'marcas' ? 'solo MARCAS (flechas)' : 'OCULTAS')) + '. Toca para cambiar.';
  }
  bBot.addEventListener('click', function () {
    var m = modoBot();
    cfg.verBot = m === 'todo' ? 'marcas' : (m === 'marcas' ? 'oculto' : 'todo');
    pintarBot();
    refrescar(window.indiceActual || 0);
    guardar();
  });
  pintarBot();

  var bTipo = document.getElementById('bTipo');
  function aplicarTipo() {
    var linea = cfg.tipoGrafico === 'linea';
    var nada = 'rgba(0,0,0,0)';
    serie.applyOptions(linea
      ? { upColor: nada, downColor: nada, wickUpColor: nada, wickDownColor: nada, borderVisible: false }
      : { upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444', borderVisible: false });
    serieL.applyOptions({ visible: linea });
    if (!linea) serieL.setData([]);
    bTipo.textContent = linea ? 'Velas' : 'Linea';
    bTipo.className = linea ? 'on' : '';
  }
  bTipo.addEventListener('click', function () {
    cfg.tipoGrafico = cfg.tipoGrafico === 'linea' ? 'velas' : 'linea';
    aplicarTipo();
    if (window.setIndice) window.setIndice(window.indiceActual || 0);
    guardar();
  });
  aplicarTipo();

  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function aplicarTz() {
    TZ = (Number(cfg.tz) || 0) * 3600;
    chart.applyOptions({
      localization: { timeFormatter: function (t) { return hora(t); } },
      timeScale: {
        tickMarkFormatter: function (t, tipo) {
          var d = new Date((t + TZ) * 1000);
          if (tipo === 3 || tipo === 4) return dosd(d.getUTCHours()) + ':' + dosd(d.getUTCMinutes());
          if (tipo === 2) return String(d.getUTCDate());
          if (tipo === 1) return MESES[d.getUTCMonth()];
          return String(d.getUTCFullYear());
        },
      },
    });
  }
  var selTz = document.getElementById('tz');
  for (var hz = -12; hz <= 14; hz++) {
    var op = document.createElement('option');
    op.value = String(hz);
    op.textContent = hz === 0 ? 'Hora MT5' : (hz > 0 ? 'MT5 +' + hz + 'h' : 'MT5 ' + hz + 'h');
    selTz.appendChild(op);
  }
  selTz.value = String(Number(cfg.tz) || 0);
  selTz.addEventListener('change', function () {
    cfg.tz = Number(selTz.value) || 0;
    aplicarTz();
    refrescar(window.indiceActual || 0);
    guardar();
  });
  aplicarTz();

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (modo === 'poli' || modo === 'ruta')) { cerrarPoli(); setModo('cursor'); }
    else if (e.key === 'Escape') { pendPts = []; pendiente = null; setModo('cursor'); }
  });

  // ---------- indice del replay ----------
  var rangoInicial = false;
  window.setIndice = function (i) {
    var indice = Math.max(0, Math.min(TODAS_VELAS.length, Math.floor(Number(i) || 0)));
    var previo = window.indiceActual === undefined ? null : window.indiceActual;
    window.indiceActual = indice;
    var velasVisibles = TODAS_VELAS.slice(0, indice);
    serie.setData(velasVisibles);
    if (cfg.tipoGrafico === 'linea') serieL.setData(velasVisibles.map(function (v) { return { time: v.time, value: v.close }; }));
    if (!rangoInicial && velasVisibles.length) {
      rangoInicial = true;
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, velasVisibles.length - 140),
        to: velasVisibles.length + 8,
      });
    }
    refrescar(previo);
  };
  window.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'setIndice') window.setIndice(event.data.indice);
  });
  window.addEventListener('resize', function () {
    chart.applyOptions({ width: window.innerWidth, height: window.innerHeight });
    ajustarCanvas();
  });

  ajustarCanvas();
  window.indiceActual = Math.min(50, TODAS_VELAS.length);
  window.setIndice(window.indiceActual);
  requestAnimationFrame(dibujar);
})();
</script>
</body></html>`;
}

function ReplayBacktest({ velas, operaciones, pasosEstrategia = [], diagnostico, simbolo, desde, hasta, indiceInicio, timeframeEntrada, timeframeMacro, onClose }: { velas: VelaReplay[]; operaciones: { tipo: string; entrada: number; sl: number; tp: number; salida: number; profit: number; hora_apertura: string; hora_cierre: string; motivo_cierre?: 'sl' | 'tp' | 'be'; be_aplicado?: boolean }[]; pasosEstrategia?: z.infer<typeof PasoEstrategiaSchema>[]; diagnostico?: z.infer<typeof BacktestDiagnosticSchema>; simbolo: string; desde: string; hasta: string; indiceInicio?: number; timeframeEntrada?: string | null; timeframeMacro?: string | null; onClose: () => void }) {
  const webviewRef = useRef<WebView>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timeframeBase = timeframeEntrada || 'M15';
  const [velasActivas, setVelasActivas] = useState(velas);
  const indiceInicioSeguro = Math.min(indiceInicio ?? Math.min(50, velas.length), velas.length);
  const [indice, setIndice] = useState(indiceInicioSeguro);
  const [indiceInicioActivo, setIndiceInicioActivo] = useState(indiceInicioSeguro);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [velocidad, setVelocidad] = useState(1);
  const [timeframe, setTimeframe] = useState(timeframeBase);
  const [cargandoVelas, setCargandoVelas] = useState(false);
  const [errorVelas, setErrorVelas] = useState('');
  // Pantalla completa estilo MT5 / TradingView: oculta cabecera y botones, deja solo el gráfico
  // + una barra mínima (play/pausa, velocidad y salir). En web también usa la Fullscreen API.
  const [pantallaCompleta, setPantallaCompleta] = useState(false);
  function alternarPantallaCompleta() {
    const siguiente = !pantallaCompleta;
    setPantallaCompleta(siguiente);
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      try {
        if (siguiente && !document.fullscreenElement) document.documentElement.requestFullscreen?.();
        else if (!siguiente && document.fullscreenElement) document.exitFullscreen?.();
      } catch { /* el navegador puede bloquear la API; el modo sin cabecera sigue funcionando */ }
    }
  }
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const alCambiar = () => { if (!document.fullscreenElement) setPantallaCompleta(false); };
    document.addEventListener('fullscreenchange', alCambiar);
    return () => document.removeEventListener('fullscreenchange', alCambiar);
  }, []);
  const tiempoReplayRef = useRef<number | null>(velas[indiceInicioSeguro - 1]?.time ?? null);
  const tiempoInicioRef = useRef<number | null>(velas[indiceInicioSeguro - 1]?.time ?? null);
  // Dibujos y operaciones manuales viven en el iframe/webview; aquí guardamos la última copia
  // para reinyectarla cuando el HTML se regenera (cambio de temporalidad).
  const estadoManualRef = useRef<string>('');
  const html = useMemo(() => construirHtmlReplay(velasActivas, operaciones, pasosEstrategia, contratoDe(simbolo), estadoManualRef.current), [velasActivas, operaciones, pasosEstrategia, simbolo]);
  const pasoActual = pasosEstrategia.filter((paso) => indice > 0 && paso.time <= (velasActivas[indice - 1]?.time ?? 0)).slice(-1)[0];
  const velocidades = [1, 2, 5, 10, 20, 50];
  const timeframesReplay = ['M1', 'M3', 'M5', 'M15', 'M30', 'H1', 'H2', 'H4', 'D1', 'W1', 'MN1'];

  function contarVelasHasta(datos: VelaReplay[], tiempo: number | null): number {
    if (tiempo === null) return 0;
    let low = 0;
    let high = datos.length;
    while (low < high) {
      const medio = Math.floor((low + high) / 2);
      if (datos[medio].time <= tiempo) low = medio + 1;
      else high = medio;
    }
    return low;
  }

  // Salta a la vela donde el bot abrió la operación siguiente/anterior (para verla correr).
  function irAOperacionBot(direccion: 1 | -1) {
    setReproduciendo(false);
    const posiciones = operaciones
      .map((op) => contarVelasHasta(velasActivas, epochUTC(op.hora_apertura)))
      .filter((c) => c > 0)
      .sort((x, y) => x - y);
    const destino = direccion === 1 ? posiciones.find((c) => c > indice) : [...posiciones].reverse().find((c) => c < indice);
    if (destino) setIndice(Math.min(velasActivas.length, destino));
  }

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const alMensaje = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; estado?: unknown } | null;
      if (data && data.type === 'estadoReplay' && typeof data.estado === 'string') estadoManualRef.current = data.estado;
    };
    window.addEventListener('message', alMensaje);
    return () => window.removeEventListener('message', alMensaje);
  }, []);

  useEffect(() => {
    if (indice > 0 && velasActivas[indice - 1]) tiempoReplayRef.current = velasActivas[indice - 1].time;
  }, [indice, velasActivas]);

  useEffect(() => {
    let cancelado = false;
    async function cargarVelas() {
      setErrorVelas('');
      if (timeframe === timeframeBase) {
        setVelasActivas(velas);
        setIndiceInicioActivo(indiceInicioSeguro);
        setIndice(Math.max(1, contarVelasHasta(velas, tiempoReplayRef.current)));
        setCargandoVelas(false);
        return;
      }

      setCargandoVelas(true);
      try {
        const query = new URLSearchParams({ desde, hasta, timeframe, simbolo });
        const resultado = await api(`/api/backtest/velas?${query.toString()}`, ReplayVelasResponseSchema);
        if ('error' in resultado) throw new Error(resultado.error);
        if (!cancelado) {
          const velasNuevas = resultado.velas;
          const indiceInicioNuevo = contarVelasHasta(velasNuevas, tiempoInicioRef.current);
          setVelasActivas(velasNuevas);
          setIndiceInicioActivo(indiceInicioNuevo);
          setIndice(Math.max(1, contarVelasHasta(velasNuevas, tiempoReplayRef.current)));
        }
      } catch (error) {
        if (!cancelado) setErrorVelas(error instanceof Error ? error.message : `No se pudieron cargar las velas de ${timeframe}`);
      } finally {
        if (!cancelado) setCargandoVelas(false);
      }
    }
    void cargarVelas();
    return () => { cancelado = true; };
  }, [timeframe, timeframeBase, velas, desde, hasta, simbolo, indiceInicioSeguro]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      iframeRef.current?.contentWindow?.postMessage({ type: 'setIndice', indice }, '*');
    } else {
      webviewRef.current?.injectJavaScript(`window.setIndice(${indice}); true;`);
    }
  }, [indice]);

  useEffect(() => {
    if (!reproduciendo) return;
    const intervalo = setInterval(() => {
      setIndice((i) => {
        if (i >= velasActivas.length) { setReproduciendo(false); return i; }
        return Math.min(velasActivas.length, i + velocidad);
      });
    }, 250);
    return () => clearInterval(intervalo);
  }, [reproduciendo, velocidad, velasActivas.length]);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#0b0f14' }}>
      {!pantallaCompleta ? <View style={[styles.replayHeader, { paddingTop: 6, paddingBottom: 4, flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.replayTitle, { fontSize: 15 }]}>{simbolo} · {timeframe}</Text>
          <Text style={styles.replayHint}>{`${desde} — ${hasta} · ${operaciones.length} ops de la estrategia${diagnostico ? ` · ${diagnostico.senales_detectadas} señales` : ''}`}</Text>
          {pasoActual ? <Text style={styles.replayHint}>Análisis: {pasoActual.texto}</Text> : null}
          {diagnostico?.timeframes_faltantes.length ? <Text style={[styles.replayHint, styles.red]}>Falta histórico de: {diagnostico.timeframes_faltantes.join(', ')}</Text> : null}
          {diagnostico && diagnostico.senales_detectadas === 0 ? <Text style={styles.replayHint}>Sin señales en este backtest: ciérralo y vuelve a ejecutarlo para ver el diagnóstico.</Text> : null}
          {cargandoVelas ? <Text style={styles.replayHint}>Cargando histórico MT5 para {timeframe}...</Text> : null}
          {errorVelas ? <Text style={styles.error}>{errorVelas}</Text> : null}
        </View>
        <Button compact label="⛶" onPress={alternarPantallaCompleta} color="#3a4656" />
        <Button compact label="✕" onPress={onClose} color="#8a2c2c" />
      </View> : null}
        {Platform.OS === 'web'
          ? createElement('iframe', {
              ref: iframeRef,
              srcDoc: html,
              title: 'Replay visual del backtest',
              onLoad: () => { iframeRef.current?.contentWindow?.postMessage({ type: 'setIndice', indice }, '*'); },
              style: { flex: 1, width: '100%', border: 'none', backgroundColor: '#0b0f14' },
            })
          : <WebView
              ref={webviewRef}
              originWhitelist={['*']}
              source={{ html }}
              style={{ flex: 1 }}
              javaScriptEnabled
              onMessage={(event) => {
                try {
                  const msg = JSON.parse(event.nativeEvent.data) as { type?: string; estado?: unknown };
                  if (msg.type === 'estadoReplay' && typeof msg.estado === 'string') estadoManualRef.current = msg.estado;
                } catch { /* mensaje ajeno al replay */ }
              }}
              onLoadEnd={() => webviewRef.current?.injectJavaScript(`window.setIndice(${indice}); true;`)}
            />}
        {pantallaCompleta ? (
          <View style={[styles.replayBar, { padding: 6, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
            <Button compact label={reproduciendo ? '⏸' : '▶'} onPress={() => { if (!cargandoVelas && !errorVelas) setReproduciendo((r) => !r); }} color="#237a4b" />
            <Button compact label="-1" onPress={() => { setReproduciendo(false); setIndice((i) => Math.max(1, i - 1)); }} />
            <Button compact label="+1" onPress={() => { setReproduciendo(false); setIndice((i) => Math.min(velasActivas.length, i + 1)); }} />
            <Button compact label={`${velocidad}x`} onPress={() => setVelocidad((v) => velocidades[(velocidades.indexOf(v) + 1) % velocidades.length])} />
            <Text style={[styles.foot, { marginTop: 0, flex: 1, textAlign: 'center' }]}>{timeframe} · Vela {indice} / {velasActivas.length}</Text>
            <Button compact label="⛶ Salir" onPress={alternarPantallaCompleta} color="#b88b35" />
          </View>
        ) : (
        <View style={[styles.replayBar, { paddingVertical: 5 }]}>
          <View style={[styles.progressTrack, { height: 3, marginBottom: 5, marginHorizontal: 8 }]}><View style={[styles.progressFill, { width: `${((indice - indiceInicioActivo) / Math.max(1, velasActivas.length - indiceInicioActivo)) * 100}%` }]} /></View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', gap: 5, paddingHorizontal: 8 }}>
            <Button compact label="⏮" onPress={() => { setReproduciendo(false); setIndice(Math.min(indiceInicioActivo, velasActivas.length)); }} />
            <Button compact label="-1" onPress={() => { setReproduciendo(false); setIndice((i) => Math.max(1, i - 1)); }} />
            <Button compact label={reproduciendo ? '⏸' : '▶'} onPress={() => { if (!cargandoVelas && !errorVelas) setReproduciendo((r) => !r); }} color="#237a4b" />
            <Button compact label="+1" onPress={() => { setReproduciendo(false); setIndice((i) => Math.min(velasActivas.length, i + 1)); }} />
            <Button compact label="+10" onPress={() => { setReproduciendo(false); setIndice((i) => Math.min(velasActivas.length, i + 10)); }} />
            <Button compact label={`${velocidad}x`} onPress={() => setVelocidad((v) => velocidades[(velocidades.indexOf(v) + 1) % velocidades.length])} />
            <Text style={[styles.foot, { marginTop: 0 }]}>{indice}/{velasActivas.length}</Text>
            {operaciones.length ? <Button compact label="◀ Op." onPress={() => irAOperacionBot(-1)} color="#3a4656" /> : null}
            {operaciones.length ? <Button compact label="Op. ▶" onPress={() => irAOperacionBot(1)} color="#3a4656" /> : null}
            {timeframesReplay.map((item) => <Button key={item} compact label={item} onPress={() => { setReproduciendo(false); setTimeframe(item); }} color={timeframe === item ? '#b88b35' : '#303b48'} />)}
          </ScrollView>
        </View>
        )}
      </View>
    </Modal>
  );
}

function Section({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) { return <View style={[styles.section, wide ? styles.sectionWide : null]}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>; }
function Button({ label, onPress, color = '#303b48', compact = false }: { label: string; onPress: () => void; color?: string; compact?: boolean }) { return <Pressable style={[styles.button, { backgroundColor: color }, compact ? { flex: 0, flexShrink: 0, minWidth: 40, paddingVertical: 7, paddingHorizontal: 8, marginBottom: 0 } : null]} onPress={onPress}><Text style={styles.buttonText}>{label}</Text></Pressable>; }
// height/maxHeight + overflow explícito: sin esto, en el navegador (react-native-web)
// un <textarea> con mucho texto (ej. una estrategia guardada con el código fuente
// completo, cientos de líneas) puede desbordarse visualmente por fuera de su caja
// y quedar flotando encima de los botones/campos que vienen después, en vez de
// quedarse adentro con scroll. overflow:'hidden' + overflowY:'scroll' fuerza a que
// SIEMPRE se recorte dentro del editor y se pueda ver el resto haciendo scroll
// adentro del cuadro. "resize:'none'" evita que el navegador deje agrandar el
// cuadro arrastrando la esquina (eso también podía descuadrar el layout).
const codeEditorStyle = {
  height: 220,
  minHeight: 220,
  maxHeight: 220,
  overflowY: 'auto' as any,
  overflowX: 'hidden' as any,
  resize: 'none' as any,
  textAlignVertical: 'top' as const,
  fontFamily: 'monospace',
  fontSize: 13,
  lineHeight: 19,
  position: 'relative' as any,
  isolation: 'isolate' as any,
  contain: 'layout paint style' as any,
  width: '100%' as any,
  boxSizing: 'border-box' as any,
};
const descriptionEditorStyle = {
  height: 90,
  minHeight: 90,
  maxHeight: 140,
  overflowY: 'auto' as any,
  resize: 'none' as any,
  position: 'relative' as any,
  isolation: 'isolate' as any,
  contain: 'layout paint style' as any,
  width: '100%' as any,
  boxSizing: 'border-box' as any,
};
function Field({ label, value, onChangeText, multiline = false, numeric = false, code = false, placeholder }: { label: string; value: string; onChangeText: (value: string) => void; multiline?: boolean; numeric?: boolean; code?: boolean; placeholder?: string }) {
  const extraStyle = multiline ? (code ? codeEditorStyle : descriptionEditorStyle) : null;
  return <View style={[styles.field, multiline && { position: 'relative' as any, zIndex: 1, isolation: 'isolate' as any }]}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} multiline={multiline} scrollEnabled={multiline} numberOfLines={multiline ? (code ? 16 : 4) : 1} keyboardType={numeric ? 'decimal-pad' : 'default'} placeholderTextColor="#687481" style={[styles.input, multiline && styles.codeInput, extraStyle]} /></View>;
}
function fechaComoDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  if (year && month && day) date.setFullYear(year, month - 1, day);
  return date;
}
function dateComoFecha(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function DateField({ label, value, onChangeText, minDate, maxDate, disabled = false }: { label: string; value: string; onChangeText: (value: string) => void; minDate?: string; maxDate?: string; disabled?: boolean }) {
  const [visible, setVisible] = useState(false);
  if (Platform.OS === 'web') return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    {createElement('input', {
      type: 'date',
      value,
      min: minDate,
      max: maxDate,
      disabled,
      onChange: (event) => onChangeText(event.currentTarget.value),
      style: {
        width: '100%', minHeight: 42, boxSizing: 'border-box', padding: 11,
        color: '#f4f1e8', backgroundColor: '#0e141b', border: '1px solid #33404d', borderRadius: 6,
        fontSize: 14, colorScheme: 'dark',
      },
    })}
  </View>;
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <Pressable style={styles.input} disabled={disabled} onPress={() => setVisible(true)}>
      <Text style={styles.dateValue}>{value || 'Elegir fecha'}</Text>
    </Pressable>
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
      <Pressable style={styles.dateModalBackdrop} onPress={() => setVisible(false)}>
        <Pressable style={styles.dateModal} onPress={(event) => event.stopPropagation()}>
          <DateTimePicker value={fechaComoDate(value)} mode="date" display="calendar" minimumDate={minDate ? fechaComoDate(minDate) : undefined} maximumDate={maxDate ? fechaComoDate(maxDate) : undefined} onChange={(event, selectedDate) => {
            if (selectedDate) onChangeText(dateComoFecha(selectedDate));
            setVisible(false);
          }} />
          <Button label="Cerrar" onPress={() => setVisible(false)} />
        </Pressable>
      </Pressable>
    </Modal>
  </View>;
}
export default function App() {
  const { width: viewportWidth } = useWindowDimensions();
  const compactLayout = viewportWidth < 760;
  const useSidebar = viewportWidth >= 1100;
  const [state, setState] = useState<State | null>(null); const [account, setAccount] = useState<Account | null>(null); const [positions, setPositions] = useState<Position[]>([]); const [history, setHistory] = useState<HistoryItem[]>([]); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false);
  const [analistaWatchlist, setAnalistaWatchlist] = useState<z.infer<typeof AnalistaWatchlistSchema> | null>(null);
  const [analistaWatchlistError, setAnalistaWatchlistError] = useState('');
  const [symbol, setSymbol] = useState(''); const [simbolosPermitidos, setSimbolosPermitidos] = useState(''); const [volume, setVolume] = useState('0.01'); const [sl, setSl] = useState(''); const [tp, setTp] = useState(''); const [orderType, setOrderType] = useState<'mercado' | 'limite'>('mercado'); const [entryPrice, setEntryPrice] = useState(''); const [blocks, setBlocks] = useState<Record<string, Block>>({}); const [keys, setKeys] = useState<string[]>([]); const [buy, setBuy] = useState<Condition[]>([]); const [sell, setSell] = useState<Condition[]>([]); const [buyOp, setBuyOp] = useState<'and' | 'or'>('and'); const [sellOp, setSellOp] = useState<'and' | 'or'>('and'); const [sendingOrder, setSendingOrder] = useState(false); const [perdidaDiariaPct, setPerdidaDiariaPct] = useState('5'); const [spreadMaximo, setSpreadMaximo] = useState('0');
  const [saved, setSaved] = useState<Saved[]>([]); const [name, setName] = useState(''); const [explanation, setExplanation] = useState(''); const [code, setCode] = useState(''); const [savedVolume, setSavedVolume] = useState(''); const [savedSl, setSavedSl] = useState(''); const [savedTp, setSavedTp] = useState('');
  const [savedUsaMultiTf, setSavedUsaMultiTf] = useState(false); const [savedTfEntrada, setSavedTfEntrada] = useState(''); const [savedTfMacro, setSavedTfMacro] = useState('');
  // Temporalidades del ESCANEO multi-timeframe (est.escanear_multitemporalidad):
  // varias a la vez, separadas por coma (ej. "M5, M15, H1, H4") — el bot decide
  // solo cuál es la "principal" para cada señal, en vez de una macro fija.
  const [savedTemporalidadesEscaneo, setSavedTemporalidadesEscaneo] = useState('');
  // Rol de cada grupo en el escaneo multi-temporalidad: dónde se BUSCA la
  // zona, cuál se usa solo para CONFIRMAR el rompimiento, cuál es solo
  // CONTEXTO (filtra/veta a favor o en contra sin abrir operación ahí,
  // pensado para extra_macro semanal/mensual), o NO_USAR (se ignora).
  type RolGrupo = 'buscar' | 'confirmar' | 'contexto' | 'no_usar';
  // Vacío = sin rol elegido (el backend usa su comportamiento por defecto).
  const [rolesTemporalidad, setRolesTemporalidad] = useState<Record<'micro' | 'intermedia' | 'macro' | 'extra_macro', RolGrupo | ''>>({
    micro: '', intermedia: '', macro: '', extra_macro: '',
  });
  // Zonas de espera que esta estrategia puede operar. Vacío = AUTOMÁTICO (el motor
  // acepta todas las que detecte). Si eliges algunas, SOLO opera esas.
  const ZONAS_ESPERA: { id: string; nombre: string; ayuda: string }[] = [
    { id: 'flip', nombre: 'Flip', ayuda: 'cambio de tendencia: primer retroceso tras romper la estructura contraria' },
    { id: 'ev', nombre: 'EV', ayuda: '1er o 2do retroceso normal desde el último Flip' },
    { id: 'obc', nombre: 'OBC', ayuda: 'continuación: 3er retroceso en adelante, o ruptura débil' },
    { id: 'fractal', nombre: 'Fractal', ayuda: 'retroceso Fibonacci 27% / 38% / 50% del impulso' },
    { id: 'fractal2', nombre: 'Fractal 2', ayuda: 'extensión 110-138% mientras la liquidez externa siga sin barrer' },
  ];
  const [zonasPermitidas, setZonasPermitidas] = useState<string[]>([]);
  // El formulario de estrategia está oculto hasta pulsar "Agregar estrategia nueva" (o Editar).
  const [formAbierto, setFormAbierto] = useState(false);
  const [posicionSeleccionada, setPosicionSeleccionada] = useState<Position | null>(null);
  const [btFrom, setBtFrom] = useState('2026-01-01'); const [btTo, setBtTo] = useState('2026-06-01'); const [btBalance, setBtBalance] = useState('10000'); const [btRunning, setBtRunning] = useState(false); const [btResult, setBtResult] = useState<BacktestResult | null>(null); const [btProgress, setBtProgress] = useState(0); const [btShowReplay, setBtShowReplay] = useState(false); const [btDisenoNuevo, setBtDisenoNuevo] = useState(true);
  const [btDateRange, setBtDateRange] = useState<{ desde: string; hasta: string } | null>(null); const [btDateError, setBtDateError] = useState('');
  const [tab, setTab] = useState<AppTab>('mercado');
  const [proyecciones, setProyecciones] = useState<z.infer<typeof ProyeccionesSchema> | null>(null);
  const [proyeccionesError, setProyeccionesError] = useState('');
  const [proyeccionesMensaje, setProyeccionesMensaje] = useState('');
  const [proyeccionOcupada, setProyeccionOcupada] = useState('');
  const [groupSymbol, setGroupSymbol] = useState('');
  const [groupSide, setGroupSide] = useState<'compra' | 'venta'>('compra');
  const [groupBuffer, setGroupBuffer] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupResult, setGroupResult] = useState<{ ok: boolean; text: string } | null>(null);
  const groupSymbols = useMemo(() => Array.from(new Set(positions.map((position) => position.simbolo))), [positions]);
  const groupPositions = useMemo(
    () => positions.filter((position) => position.simbolo === groupSymbol && position.tipo === groupSide),
    [positions, groupSymbol, groupSide],
  );
  useEffect(() => {
    if (groupSymbols.length && !groupSymbols.includes(groupSymbol)) setGroupSymbol(groupSymbols[0]);
  }, [groupSymbols, groupSymbol]);
  const [maxOperaciones, setMaxOperaciones] = useState('1');
  const [gruposTemporalidadTexto, setGruposTemporalidadTexto] = useState('');
  // Escaneo por temporalidades: Automático (grupos y roles por defecto) o Manual (tú eliges).
  const [escaneoManual, setEscaneoManual] = useState(false);
  const [estadisticas, setEstadisticas] = useState<z.infer<typeof EstadisticasSchema> | null>(null);
  const [bitacora, setBitacora] = useState<z.infer<typeof NotaBitacoraSchema>[]>([]);
  const [notaNueva, setNotaNueva] = useState('');
  const [diario, setDiario] = useState<z.infer<typeof DiarioSchema>[]>([]); const [diarioStats, setDiarioStats] = useState<z.infer<typeof DiarioStatsSchema> | null>(null);
  async function cargarEstadisticasYBitacora() {
    try { setEstadisticas(await api('/api/estadisticas?dias=30', EstadisticasSchema, {})); } catch { }
    try { setBitacora(await api('/api/bitacora', z.array(NotaBitacoraSchema), {})); } catch { }
    try { setDiario(await api('/api/diario', z.array(DiarioSchema), {})); } catch { }
    try { setDiarioStats(await api('/api/diario/estadisticas', DiarioStatsSchema, {})); } catch { }
  }
  async function agregarNota() {
    if (!notaNueva.trim()) return;
    await api('/api/bitacora', NotaBitacoraSchema, post({ nota: notaNueva.trim() }));
    setNotaNueva('');
    cargarEstadisticasYBitacora();
  }
  async function borrarNota(id: number) {
    await api(`/api/bitacora/${id}`, z.object({ ok: z.boolean() }), { method: 'DELETE' });
    cargarEstadisticasYBitacora();
  }
  async function borrarTodaLaBitacora() {
    await api('/api/bitacora', z.object({ ok: z.boolean() }), { method: 'DELETE' });
    cargarEstadisticasYBitacora();
  }
  // --- Telegram ---
  const [tgActivo, setTgActivo] = useState(false); const [tgToken, setTgToken] = useState(''); const [tgChatId, setTgChatId] = useState('');
  const [tgAvisoApertura, setTgAvisoApertura] = useState(true); const [tgAvisoCierre, setTgAvisoCierre] = useState(true);
  const [tgAvisoSlTp, setTgAvisoSlTp] = useState(true); const [tgAvisoParcial, setTgAvisoParcial] = useState(true); const [tgAvisoZona, setTgAvisoZona] = useState(true);
  const [tgProbando, setTgProbando] = useState(false);
  // --- Fundamentales (NFP, IPC, tasas...) ---
  const [fundamentales, setFundamentales] = useState<z.infer<typeof FundamentalesSchema>>({ pendientes: [], en_proceso: [], pasados: [] });
  const cargarProyecciones = useCallback(async () => {
    try {
      setProyecciones(await api('/api/analista/proyecciones', ProyeccionesSchema));
      setProyeccionesError('');
    } catch (error) {
      setProyeccionesError(error instanceof Error ? error.message : 'No se pudieron cargar las proyecciones');
    }
  }, []);
  useEffect(() => {
    if (tab !== 'proyecciones') return;
    cargarProyecciones();
    const timer = setInterval(cargarProyecciones, 10000);
    return () => clearInterval(timer);
  }, [tab, cargarProyecciones]);
  function confirmarOperacionProyeccion(simbolo: string, clave: string, escenario: z.infer<typeof ProyeccionAnalistaSchema>) {
    const tipo = escenario.direccion === 'alcista' ? 'COMPRA' : 'VENTA';
    const detalle = `${tipo} ${simbolo}\nEntrada ref. ${escenario.entrada} · SL ${escenario.sl}\n${escenario.operaciones.map((op) => {
      const lote = escenario.lotes.find((item) => item.operacion === op.nombre)?.lote ?? 0;
      return `${op.nombre}: ${lote} lotes · TP ${op.tp}`;
    }).join('\n')}\n\n¿Enviar la orden a MT5?`;
    const ejecutar = async () => {
      const id = `${simbolo}:${clave}`;
      setProyeccionOcupada(id);
      setProyeccionesError('');
      setProyeccionesMensaje('');
      try {
        const resultado = await api('/api/analista/proyecciones/operar', z.object({
          ok: z.boolean(),
          resultados: z.array(z.string()),
        }), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ simbolo, clave }) });
        if (resultado.ok) setProyeccionesMensaje(resultado.resultados.join(' · '));
        else setProyeccionesError(resultado.resultados.join(' · ') || 'La orden no se abrió.');
        await cargarProyecciones();
      } catch (error) {
        setProyeccionesError(error instanceof Error ? error.message : 'No se pudo enviar la orden');
      } finally {
        setProyeccionOcupada('');
      }
    };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`Confirmar operación de SpotPlus\n\n${detalle}`)) void ejecutar();
      return;
    }
    Alert.alert('Confirmar operación de SpotPlus', detalle, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Enviar orden', onPress: () => { void ejecutar(); } },
    ]);
  }
  async function cargarFundamentales() {
    try { setFundamentales(await api('/api/fundamentales', FundamentalesSchema, {})); } catch { }
  }
  function formatearHoraEvento(iso: string): string {
    try { return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true, day: '2-digit', month: 'short' }); } catch { return iso; }
  }
  const load = useCallback(async () => { try { const [s, a, p, h, catalog, list, tg] = await Promise.all([api('/api/estado', StateSchema), api('/api/cuenta', AccountResponseSchema), api('/api/posiciones', z.array(PositionSchema)), api('/api/historial?dias=7', z.array(HistoryItemSchema)), api('/api/bloques_disponibles', BloquesDisponiblesSchema), api('/api/estrategias_guardadas', z.array(SavedSchema)), api('/api/telegram', TelegramConfigSchema)]); setState(s); setAccount('error' in a ? null : a); setPositions(p); setHistory(h); setBlocks(catalog.bloques); setKeys(Object.keys(catalog.bloques)); setSaved(list); setSymbol(s.config?.simbolo || ''); setPerdidaDiariaPct(String(s.config?.circuito_perdida_diaria_pct ?? 5)); setSpreadMaximo(String(s.config?.spread_maximo_puntos ?? 0)); setMaxOperaciones(String(s.config?.max_operaciones_por_simbolo ?? 1));
      try {
        setAnalistaWatchlist(await api('/api/analista/watchlist', AnalistaWatchlistSchema));
        setAnalistaWatchlistError('');
      } catch (error) {
        setAnalistaWatchlist(null);
        setAnalistaWatchlistError(error instanceof Error ? error.message : 'No se pudo cargar la lista de activos');
      }
      setGruposTemporalidadTexto(Object.entries(s.config?.grupos_temporalidad || {}).map(([tf, grupo]) => `${tf}:${grupo}`).join(', '));
      setTgActivo(tg.activo); setTgToken(tg.bot_token); setTgChatId(tg.chat_id); setTgAvisoApertura(tg.aviso_apertura); setTgAvisoCierre(tg.aviso_cierre); setTgAvisoSlTp(tg.aviso_sl_tp); setTgAvisoParcial(tg.aviso_parcial); setTgAvisoZona(tg.aviso_zona); setMessage(''); } catch (error) { setMessage(error instanceof Error ? error.message : 'No se pudo conectar al backend'); } finally { setLoading(false); setRefreshing(false); } }, []);
  useEffect(() => { load(); cargarFundamentales(); const timer = setInterval(() => { load(); cargarFundamentales(); }, 10000); return () => clearInterval(timer); }, [load]);
  useEffect(() => {
    const simbolo = state?.config?.simbolo;
    if (!simbolo) return;
    let cancelado = false;
    setBtDateRange(null);
    async function cargarRangoFechas() {
      try {
        setBtDateError('');
        const rango = await api('/api/backtest/analista/rango', BacktestDateRangeSchema);
        if (cancelado) return;
        if (!rango.desde || !rango.hasta) {
          setBtDateRange(null);
          setBtDateError(`No hay datos históricos disponibles para ${simbolo}.`);
          return;
        }
        const { desde, hasta } = rango;
        setBtDateRange({ desde, hasta });
        setBtFrom((actual) => actual < desde || actual > hasta ? desde : actual);
        setBtTo((actual) => actual < desde || actual > hasta ? hasta : actual);
      } catch (error) {
        if (!cancelado) setBtDateError(error instanceof Error ? error.message : 'No se pudo cargar el rango histórico');
      }
    }
    void cargarRangoFechas();
    return () => { cancelado = true; };
  }, [state?.config?.simbolo]);
  // Precio en vivo: el backend refresca el tick cada 1 s, así que el panel consulta solo
  // /api/estado cada 1 s (ligero) en vez de esperar al refresco completo de 10 s.
  useEffect(() => {
    let activo = true; let enCurso = false;
    const timer = setInterval(async () => {
      if (enCurso || (typeof document !== 'undefined' && document.hidden)) return;
      enCurso = true;
      try { const st = await api('/api/estado', StateSchema); if (activo) setState(st); } catch { } finally { enCurso = false; }
    }, 1000);
    return () => { activo = false; clearInterval(timer); };
  }, []);
  useEffect(() => { if (tab !== 'historial') return; cargarEstadisticasYBitacora(); const t = setInterval(cargarEstadisticasYBitacora, 15000); return () => clearInterval(t); }, [tab]);
  async function run(path: string, body: unknown, success: string, method = 'POST') {
    try {
      const options = method === 'DELETE' 
        ? { method: 'DELETE', headers: { 'Content-Type': 'application/json' } } 
        : post(body);
      const result = await api(path, RunResultSchema, options);
      setMessage(result.error || (result.ticket ? `${success}. Ticket ${result.ticket}` : success));
      await load();
      setMessage(result.error || (result.ticket ? `${success}. Ticket ${result.ticket}` : success));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'La operación falló');
    }
  }
  function add(type: 'buy' | 'sell') { if (!keys.length) return; const key = keys[0]; const item = { bloque: key, parametros: Object.fromEntries(blocks[key].parametros.map((p) => [p.nombre, p.default])) }; type === 'buy' ? setBuy([...buy, item]) : setSell([...sell, item]); }
  function change(type: 'buy' | 'sell', index: number) { const list = type === 'buy' ? [...buy] : [...sell]; const key = keys[(keys.indexOf(list[index].bloque) + 1) % keys.length]; list[index] = { bloque: key, parametros: Object.fromEntries(blocks[key].parametros.map((p) => [p.nombre, p.default])) }; type === 'buy' ? setBuy(list) : setSell(list); }
  function edit(type: 'buy' | 'sell', index: number, parameter: string, value: string) { const list = type === 'buy' ? [...buy] : [...sell]; list[index] = { ...list[index], parametros: { ...list[index].parametros, [parameter]: value } }; type === 'buy' ? setBuy(list) : setSell(list); }
  function renderConditions(type: 'buy' | 'sell', list: Condition[]) { return list.map((item, index) => { const block = blocks[item.bloque]; return <View style={styles.condition} key={`${type}-${index}`}><View style={styles.conditionHeader}><Text style={styles.conditionTitle}>{block?.nombre}</Text><Pressable onPress={() => type === 'buy' ? setBuy(buy.filter((_, i) => i !== index)) : setSell(sell.filter((_, i) => i !== index))}><Text style={styles.remove}>Quitar</Text></Pressable></View><Text style={styles.explanation}>{block?.explicacion}</Text><Button label="Cambiar bloque" onPress={() => change(type, index)} color="#273644" />{block?.parametros.map((p) => <Field key={p.nombre} label={p.etiqueta} value={String(item.parametros[p.nombre] ?? '')} onChangeText={(value) => edit(type, index, p.nombre, value)} numeric={p.tipo === 'numero'} />)}</View>; }); }
  async function exportarGuardada(item: Saved) {
    const texto = item.codigo || 'Sin código guardado.';
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(texto);
        setMessage(`Código de "${item.nombre}" copiado al portapapeles`);
        return;
      }
    } catch { }
    Alert.alert(`Código: ${item.nombre}`, texto, [{ text: 'Cerrar', style: 'cancel' }]);
    setMessage(`Mostrando el código de "${item.nombre}"`);
  }
  function saveBlocks() { if (!buy.length && !sell.length) { Alert.alert('Faltan condiciones', 'Agrega una condición.'); return; } run('/api/estrategia_bloques', { condiciones_compra: buy, operador_compra: buyOp, condiciones_venta: sell, operador_venta: sellOp }, 'Estrategia visual guardada'); }
  async function guardarTelegram() {
    try {
      const payload: Record<string, unknown> = {
        activo: tgActivo,
        aviso_apertura: tgAvisoApertura,
        aviso_cierre: tgAvisoCierre,
        aviso_sl_tp: tgAvisoSlTp,
        aviso_parcial: tgAvisoParcial,
        aviso_zona: tgAvisoZona,
      };
      const token = tgToken.trim();
      const chatId = tgChatId.trim();
      if (token) payload.bot_token = token;
      if (chatId) payload.chat_id = chatId;
      const tg = await api('/api/telegram', TelegramConfigSchema, post(payload));
      setTgActivo(tg.activo);
      setTgToken(tg.bot_token);
      setTgChatId(tg.chat_id);
      setMessage('Configuración de Telegram guardada');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'No se pudo guardar la configuración de Telegram'); }
  }
  async function probarTelegram() {
    setTgProbando(true);
    try {
      await guardarTelegram();
      const resultado = await api('/api/telegram/probar', TelegramProbarSchema, post({}));
      setMessage(resultado.ok ? 'Mensaje de prueba enviado a Telegram' : `Telegram rechazó el mensaje: ${resultado.error || 'sin detalle'}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'No se pudo mandar el mensaje de prueba'); }
    setTgProbando(false);
  }
  function rolesElegidos() {
    return Object.fromEntries(Object.entries(rolesTemporalidad).filter(([, v]) => v)) as Record<string, string>;
  }
  function cambiarTemporalidadEscaneo(timeframe: string) {
    const seleccionadas = new Set(
      savedTemporalidadesEscaneo.split(/[,\s]+/).map((tf) => tf.trim().toUpperCase()).filter(Boolean),
    );
    if (seleccionadas.has(timeframe)) seleccionadas.delete(timeframe);
    else seleccionadas.add(timeframe);
    setSavedTemporalidadesEscaneo(
      TEMPORALIDADES_ESCANEO.filter((tf) => seleccionadas.has(tf)).join(', '),
    );
  }
  function guardarTemporalidadesActivas(temporalidades: string[]) {
    const seleccionadas = new Set(temporalidades.map((tf) => tf.toUpperCase()));
    const ordenadas = TEMPORALIDADES_ESCANEO.filter((tf) => seleccionadas.has(tf));
    run(
      '/api/config',
      { temporalidades_escaneo: ordenadas },
      ordenadas.length ? 'Temporalidades activas actualizadas' : 'Escaneo multi-temporalidad desactivado',
    );
  }
  // Deja el formulario "Agregar estrategia" totalmente en blanco (como la primera vez),
  // para que una estrategia nueva NUNCA herede valores de la anterior.
  function resetFormularioEstrategia() {
    setName(''); setExplanation(''); setCode(''); setEditando(null);
    setSavedSl(''); setSavedTp(''); setSavedVolume('');
    setSavedUsaMultiTf(false); setSavedTfEntrada(''); setSavedTfMacro('');
    setSavedTemporalidadesEscaneo('');
    setRolesTemporalidad({ micro: '', intermedia: '', macro: '', extra_macro: '' });
    setZonasPermitidas([]);
    setFormAbierto(false);
  }
  // Formulario vacío y visible (para empezar una estrategia nueva).
  function nuevaEstrategiaEnBlanco() { resetFormularioEstrategia(); setFormAbierto(true); }
  function saveLibrary() {
    const nombre = name.trim();
    if (!nombre || !code.trim()) { Alert.alert('Faltan datos', 'Escribe nombre y código.'); return; }
    const yaExiste = saved.some((item) => item.nombre.toLowerCase() === nombre.toLowerCase());
    if (yaExiste && !editando) {
      Alert.alert(
        'Estrategia existente',
        `Ya existe "${nombre}". Se actualizará la versión guardada.`,
        [
          { text: 'Cancelar', style: 'cancel' },
          { text: 'Actualizar', onPress: () => {
              setEditando(nombre);
              run('/api/estrategias_guardadas', { nombre, explicacion: explanation, codigo: code, volumen: Number(savedVolume) || 0.01, sl: Number(savedSl) || 0, tp: Number(savedTp) || 0, usa_multi_temporalidad: savedUsaMultiTf, timeframe_entrada: savedTfEntrada, timeframe_macro: savedTfMacro, temporalidades_escaneo: savedTemporalidadesEscaneo.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean), roles_temporalidad: rolesElegidos(), zonas_permitidas: zonasPermitidas }, 'Estrategia actualizada');
              resetFormularioEstrategia();
            } },
        ],
      );
      return;
    }
    run('/api/estrategias_guardadas', { nombre, explicacion: explanation, codigo: code, volumen: Number(savedVolume) || 0.01, sl: Number(savedSl) || 0, tp: Number(savedTp) || 0, usa_multi_temporalidad: savedUsaMultiTf, timeframe_entrada: savedTfEntrada, timeframe_macro: savedTfMacro, temporalidades_escaneo: savedTemporalidadesEscaneo.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean), roles_temporalidad: rolesElegidos(), zonas_permitidas: zonasPermitidas }, 'Estrategia guardada');
    resetFormularioEstrategia();
  }
  async function guardarEstrategiaActual() {
    const nombre = name.trim() || 'Estrategia actual';
    const explicacion = explanation.trim() || `Snapshot de la estrategia activa en el backend (${state?.config?.estrategia || 'manual'}).`;
    const codigo = code.trim() || '# Estrategia guardada desde el backend\n';
    try {
      const yaExiste = saved.some((item) => item.nombre.toLowerCase() === nombre.toLowerCase());
      if (yaExiste && !editando) {
        Alert.alert(
          'Estrategia existente',
          `Ya existe "${nombre}". Se sobrescribirá la estrategia guardada actual.`,
          [
            { text: 'Cancelar', style: 'cancel' },
            { text: 'Sobrescribir', onPress: async () => {
                const result = await api('/api/estrategias_guardadas/desde_actual', RunResultSchema, post({ nombre, explicacion, codigo, volumen: Number(savedVolume) || 0.01, sl: Number(savedSl) || 0, tp: Number(savedTp) || 0 }));
                setMessage(result.error || 'Estrategia activa actualizada en la biblioteca');
                await load();
                resetFormularioEstrategia();
              } },
          ],
        );
        return;
      }
      const result = await api('/api/estrategias_guardadas/desde_actual', RunResultSchema, post({ nombre, explicacion, codigo, volumen: Number(savedVolume) || 0.01, sl: Number(savedSl) || 0, tp: Number(savedTp) || 0 }));
      setMessage(result.error || 'Estrategia activa guardada en la biblioteca');
      await load();
      resetFormularioEstrategia();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo guardar la estrategia activa');
    }
  }
  const [editando, setEditando] = useState<string | null>(null);
  function editarGuardada(item: Saved) {
    setName(item.nombre);
    setExplanation(item.explicacion);
    setCode(item.codigo);
    setSavedSl(String(item.sl));
    setSavedTp(String(item.tp));
    setSavedUsaMultiTf(!!item.usa_multi_temporalidad);
    setSavedTfEntrada(item.timeframe_entrada || '');
    setSavedTfMacro(item.timeframe_macro || '');
    setSavedTemporalidadesEscaneo((item.temporalidades_escaneo || []).join(', '));
    const rolesGuardados = (item.roles_temporalidad || {}) as Record<string, string>;
    setEscaneoManual(Object.values(rolesGuardados).some(Boolean));
    setRolesTemporalidad({
      micro: (rolesGuardados.micro as any) || '',
      intermedia: (rolesGuardados.intermedia as any) || '',
      macro: (rolesGuardados.macro as any) || '',
      extra_macro: (rolesGuardados.extra_macro as any) || '',
    });
    setZonasPermitidas((item.zonas_permitidas || []).filter((z) => ZONAS_ESPERA.some((e) => e.id === z)));
    setSavedVolume(String(item.volumen));
    setEditando(item.nombre);
    setFormAbierto(true);
    setMessage(`Editando "${item.nombre}" — sus datos se cargaron en el formulario de arriba.`);
  }
  function order(type: 'compra' | 'venta') {
    const amount = Number(volume);
    if (!amount || amount <= 0) { Alert.alert('Volumen inválido', 'Debe ser mayor que cero.'); return; }
    const label = type === 'venta' ? 'VENDER' : 'COMPRAR';
    if (orderType === 'limite' && (!Number(entryPrice) || Number(entryPrice) <= 0)) { Alert.alert('Falta el precio', 'Indica el precio de entrada de la orden límite.'); return; }
    const mensaje = `${label} ${amount} lotes de ${symbol || 'el símbolo activo'}\nTipo: ${orderType === 'limite' ? `Límite a ${entryPrice}` : 'Mercado'}\n\nEsta acción enviará una orden a MetaTrader 5.`;
    // En web, Alert.alert de React Native NO soporta botones con callbacks
    // (Cancelar/Confirmar) de forma confiable: el clic no dispara onPress y
    // por eso parecía que el botón "no hacía nada". Ahí usamos
    // window.confirm, que sí bloquea y devuelve true/false. En app nativa
    // (iOS/Android) sí funciona Alert.alert con botones normalmente.
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`Confirmar operación\n\n${mensaje}`)) {
        confirmOrder(type);
      }
      return;
    }
    Alert.alert(
      'Confirmar operación',
      mensaje,
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Confirmar', style: type === 'venta' ? 'destructive' : 'default', onPress: () => confirmOrder(type) },
      ],
    );
  }
  async function confirmOrder(type: 'compra' | 'venta') {
    setSendingOrder(true); setMessage(`Enviando ${type === 'venta' ? 'vender' : 'comprar'}...`);
    await run('/api/orden', { tipo: type, simbolo: symbol, volumen: Number(volume), sl: Number(sl) || 0, tp: Number(tp) || 0, tipo_orden: orderType, precio_entrada: Number(entryPrice) || 0 }, `Orden de ${type} ${orderType} enviada`);
    setSendingOrder(false);
  }
  async function executeGroupAction(action: 'cerrar' | 'mover_sl') {
    setGroupBusy(true);
    setGroupResult(null);
    try {
      const resultado = await api(
        '/api/posiciones/accion-grupal',
        BulkActionResultSchema,
        post({
          simbolo: groupSymbol,
          tipo: groupSide,
          accion: action,
          ...(action === 'mover_sl' ? { colchon_puntos: Number(groupBuffer) } : {}),
        }),
      );
      const exitosas = resultado.exitosas ?? [];
      const omitidas = resultado.omitidas ?? [];
      const fallidas = resultado.fallidas ?? [];
      const detalle = [
        `${exitosas.length} ejecutada(s).`,
        ...exitosas.map((item) => `Ticket ${item.ticket}${item.sl != null ? ` · SL ${item.sl}` : ''}`),
        ...omitidas.map((item) => `Ticket ${item.ticket} omitido: ${item.motivo}`),
        ...fallidas.map((item) => `Ticket ${item.ticket} falló: ${item.error}`),
      ];
      if (resultado.error) detalle.unshift(resultado.error);
      setGroupResult({ ok: resultado.ok, text: detalle.join('\n') });
      await load();
    } catch (error) {
      setGroupResult({
        ok: false,
        text: error instanceof Error ? error.message : 'No se pudo completar la acción grupal.',
      });
    } finally {
      setGroupBusy(false);
    }
  }
  function confirmGroupAction(action: 'cerrar' | 'mover_sl') {
    if (!groupSymbol || groupPositions.length === 0 || groupBusy) {
      Alert.alert('No hay posiciones', 'No hay posiciones abiertas que coincidan con el símbolo y lado seleccionados.');
      return;
    }
    const buffer = Number(groupBuffer);
    if (action === 'mover_sl' && (!Number.isFinite(buffer) || buffer <= 0)) {
      Alert.alert('Colchón inválido', 'Indica un colchón mayor que cero en puntos del símbolo.');
      return;
    }
    const nombresAccion = action === 'cerrar' ? 'CERRAR' : 'MOVER EL SL';
    const resumen = `${nombresAccion} ${groupPositions.length} posición(es) ${groupSide.toUpperCase()} de ${groupSymbol}.`
      + (action === 'mover_sl' ? `\nColchón: ${buffer} puntos (${groupBuffer} × el punto del símbolo).` : '')
      + '\nEl servidor volverá a comprobar las posiciones justo antes de actuar.';
    const ejecutar = () => { void executeGroupAction(action); };
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`Confirmar acción grupal\n\n${resumen}`)) ejecutar();
      return;
    }
    Alert.alert('Confirmar acción grupal', resumen, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Confirmar', style: action === 'cerrar' ? 'destructive' : 'default', onPress: ejecutar },
    ]);
  }
  // El backend arranca el backtest en un hilo aparte y devuelve un job_id al
  // instante. Acá se hace polling del % de avance en vez de quedarse
  // congelado en "Simulando..." sin saber cuánto falta.
  async function runBacktest() {
    if (!btDateRange) { Alert.alert('Sin datos históricos', btDateError || 'Espera a que se cargue el rango de fechas disponible.'); return; }
    if (!btFrom.trim() || !btTo.trim()) { Alert.alert('Faltan fechas', 'Elige las fechas desde y hasta en el calendario.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(btFrom.trim()) || !/^\d{4}-\d{2}-\d{2}$/.test(btTo.trim())) { Alert.alert('Formato de fecha inválido', 'Usa el formato AAAA-MM-DD.'); return; }
    if (btTo < btFrom) { Alert.alert('Rango de fechas inválido', 'La fecha HASTA debe ser igual o posterior a DESDE.'); return; }
    setBtRunning(true); setBtResult(null); setBtProgress(0);
    try {
      const { job_id } = await api('/api/backtest/analista', BacktestStartSchema, post({ desde: btFrom.trim(), hasta: btTo.trim(), balance_inicial: Number(btBalance) || 10000 }));
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((r) => setTimeout(r, 800));
        const progreso = await api(`/api/backtest/progreso/${job_id}`, BacktestProgresoSchema);
        if ('error' in progreso) { setBtResult({ error: progreso.error }); break; }
        setBtProgress(progreso.porcentaje);
        if (progreso.listo) {
          setBtResult(progreso.resultado || { error: 'El backtest terminó sin devolver resultados. Revisa la conexión con MT5 y el rango de fechas.' });
          break;
        }
      }
    } catch (error) {
      setBtResult({ error: error instanceof Error ? error.message : 'El backtest falló' });
    } finally {
      setBtRunning(false); setBtProgress(0);
    }
  }
  if (loading) return <View style={styles.center}><ActivityIndicator color="#d7ae5b" size="large" /><Text style={styles.muted}>Conectando con SpotPlus...</Text></View>;
  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={[styles.appShell, useSidebar ? styles.appShellDesktop : null]}>
        {useSidebar ? (
          <View style={styles.sidebar}>
            <View style={styles.brand}>
              <View style={styles.brandMark}><Text style={styles.brandMarkText}>S</Text></View>
              <View><Text style={styles.brandName}>SpotPlus</Text><Text style={styles.brandCaption}>TRADING DESK</Text></View>
            </View>
            <Text style={styles.navCaption}>ESPACIO DE TRABAJO</Text>
            <View style={styles.navList}>
              {NAV_ITEMS.map((item) => (
                <Pressable
                  key={item.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected: tab === item.key }}
                  onPress={() => setTab(item.key)}
                  style={[styles.navButton, tab === item.key && styles.navButtonActive]}
                >
                  <View style={[styles.navIcon, tab === item.key && styles.navIconActive]}>
                    <Text style={[styles.navIconText, tab === item.key && styles.navIconTextActive]}>{item.short}</Text>
                  </View>
                  <Text style={[styles.navLabel, tab === item.key && styles.navLabelActive]}>{item.label}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.sidebarFooter}>
              <View style={[styles.statusIndicator, state?.conectado ? styles.statusIndicatorOnline : styles.statusIndicatorOffline]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.sidebarStatusText}>{state?.conectado ? 'MT5 conectado' : 'MT5 desconectado'}</Text>
                <Text style={styles.sidebarStatusSub}>{state?.config?.activo ? 'Bot activo' : 'Bot pausado'}</Text>
              </View>
            </View>
          </View>
        ) : null}
        <View style={styles.main}>
          <ScrollView
            contentContainerStyle={[
              styles.contentGrid,
              compactLayout ? styles.contentGridCompact : null,
              useSidebar ? styles.contentGridDesktop : null,
            ]}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#d7ae5b" />}
          >
            <View style={[styles.header, compactLayout && styles.headerCompact]}>
              <View style={styles.titleGroup}>
                <Text style={styles.kicker}>SPOTPLUS / CENTRO DE CONTROL</Text>
                <Text style={[styles.title, compactLayout && styles.titleCompact]}>
                  {tab === 'mercado' ? 'Resumen' : NAV_ITEMS.find((item) => item.key === tab)?.label}
                </Text>
              </View>
              {account ? (
                <View style={[styles.resumen, compactLayout && styles.resumenCompact]}>
                  <View style={styles.resumenChip}><Text style={styles.muted}>BALANCE</Text><Text style={styles.resumenValor}>{Number(account.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {account.moneda}</Text></View>
                  <View style={styles.resumenChip}><Text style={styles.muted}>EQUIDAD</Text><Text style={styles.resumenValor}>{Number(account.equity).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {account.moneda}</Text></View>
                  <View style={styles.resumenChip}><Text style={styles.muted}>FLOTANTE</Text><Text style={[styles.resumenValor, account.profit >= 0 ? styles.green : styles.red]}>{account.profit >= 0 ? '+' : ''}{Number(account.profit).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {account.moneda}</Text></View>
                  <View style={styles.resumenChip}><Text style={styles.muted}>CUENTA</Text><Text style={styles.resumenValor}>{account.es_real ? 'REAL' : 'DEMO'}</Text></View>
                </View>
              ) : null}
              {!useSidebar ? (
                <View style={[styles.connection, state?.conectado ? styles.online : styles.offline]}>
                  <View style={[styles.dot, state?.conectado ? styles.dotOnline : styles.dotOffline]} />
                  <Text style={styles.connectionText}>{state?.conectado ? 'MT5 en línea' : 'MT5 sin conexión'}</Text>
                </View>
              ) : null}
            </View>
            {message ? <Text style={styles.message}>{message}</Text> : null}
            {state?.error ? <Text style={styles.error}>{state.error}</Text> : null}
            {!useSidebar ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabScroll} contentContainerStyle={styles.tabBar}>
                {NAV_ITEMS.map((item) => (
                  <Pressable
                    key={item.key}
                    accessibilityRole="button"
                    accessibilityState={{ selected: tab === item.key }}
                    onPress={() => setTab(item.key)}
                    style={[styles.tabButton, tab === item.key && styles.tabButtonActive]}
                  >
                    <Text style={[styles.tabButtonText, tab === item.key && styles.tabButtonTextActive]}>{item.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
  {tab === 'vivo' && <View style={{ width: '100%' }}><GraficoVivo apiUrl={API_URL} apiKey={API_KEY} simboloInicial={state?.config?.simbolo} /></View>}
  {tab === 'mercado' && <>
    <Section title="Activos en seguimiento">
      <Text style={styles.explanation}>Instrumentos seleccionados para el análisis y la operativa.</Text>
      {analistaWatchlist ? (
        analistaWatchlist.operar.length ? (
          <View style={styles.assetList}>
            {analistaWatchlist.operar.map((item) => <View key={item} style={styles.assetChip}><Text style={styles.assetChipText}>{item}</Text></View>)}
          </View>
        ) : <View style={styles.emptyState}><Text style={styles.emptyTitle}>Sin activos seleccionados</Text><Text style={styles.explanation}>Agrega instrumentos desde Estrategia.</Text></View>
      ) : <Text style={analistaWatchlistError ? styles.error : styles.muted}>{analistaWatchlistError || 'Cargando activos…'}</Text>}
    </Section>
    <Section title="Estado operativo">
      <View style={styles.operationalRow}>
        <Text style={styles.label}>CONEXIÓN MT5</Text>
        <Text style={[styles.operationalValue, state?.conectado ? styles.green : styles.red]}>{state?.conectado ? 'En línea' : 'Sin conexión'}</Text>
      </View>
      <View style={styles.operationalRow}>
        <Text style={styles.label}>BOT</Text>
        <Text style={styles.operationalValue}>{state?.config?.activo ? 'Activo' : 'Pausado'}</Text>
      </View>
      <View style={styles.operationalRow}>
        <Text style={styles.label}>POSICIONES ABIERTAS</Text>
        <Text style={styles.operationalValue}>{positions.length}</Text>
      </View>
      {account ? <Text style={styles.foot}>{account.servidor} · Cuenta {account.es_real ? 'real' : 'demo'} · Apalancamiento 1:{account.apalancamiento}</Text> : <Text style={styles.foot}>Cuenta no disponible</Text>}
      <Text style={styles.foot}>
        {state?.config?.activo
          ? analistaWatchlist?.ejecucion_activa
            ? 'Ejecución automática configurada'
            : 'Modo de avisos; no abre órdenes automáticamente'
          : 'Bot pausado; no ejecuta órdenes automáticas'}
      </Text>
    </Section>
    <Section wide title={`Posiciones abiertas · ${positions.length}`}>
      {positions.length ? positions.slice(0, 6).map((item) => (
        <View style={styles.position} key={item.ticket}>
          <View style={styles.positionHeader}>
            <Text style={[styles.badge, item.tipo === 'compra' ? styles.buyBadge : styles.sellBadge]}>{item.tipo.toUpperCase()}</Text>
            <Text style={styles.positionName}>{item.simbolo} · {item.volumen} lotes</Text>
            <Text style={[styles.positionProfit, item.profit >= 0 ? styles.green : styles.red]}>{item.profit >= 0 ? '+' : ''}{item.profit} {account?.moneda || ''}</Text>
          </View>
          <Text style={styles.muted}>Entrada {item.precio_apertura} · Actual {item.precio_actual}</Text>
        </View>
      )) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No hay posiciones abiertas</Text>
          <Text style={styles.explanation}>Cuando se abra una operación, aparecerá aquí con su dirección, activo y resultado flotante.</Text>
        </View>
      )}
    </Section>
    <Section wide title="Operaciones recientes">
      {history.length ? history.slice(0, 5).map((item) => (
        <View style={styles.position} key={item.ticket}>
          <View style={styles.positionHeader}>
            <Text style={[styles.badge, item.tipo === 'compra' ? styles.buyBadge : styles.sellBadge]}>{item.tipo.toUpperCase()}</Text>
            <Text style={styles.positionName}>{item.simbolo} · {item.volumen} lotes</Text>
            <Text style={[styles.positionProfit, item.profit >= 0 ? styles.green : styles.red]}>{item.profit >= 0 ? '+' : ''}{item.profit} {account?.moneda || ''}</Text>
          </View>
          <Text style={styles.muted}>Cerrada · {formatearHora12(item.hora)}</Text>
        </View>
      )) : <View style={styles.emptyState}><Text style={styles.emptyTitle}>Sin actividad reciente</Text><Text style={styles.explanation}>Las operaciones cerradas aparecerán aquí.</Text></View>}
    </Section>
  </>}
  {tab === 'proyecciones' && <Section wide title="Proyecciones SpotPlus">
    <Text style={styles.explanation}>Aquí aparecen todos tus activos, las señales de la estrategia y las operaciones abiertas. En modo automático, SpotPlus solo opera con señal confirmada y las reglas del paso 9.</Text>
    {proyecciones ? <>
      <Text style={[styles.message, { backgroundColor: proyecciones.escaner.corriendo ? '#183b2a' : '#3a2024', color: proyecciones.escaner.corriendo ? '#70e0a3' : '#ff9999' }]}>
        {proyecciones.escaner.corriendo
          ? `Escáner activo · última vuelta hace ${proyecciones.escaner.hace_min ?? '—'} min`
          : 'Escáner apagado o proyecciones vencidas; no se pueden ejecutar entradas.'}
        {proyecciones.mt5_conectado
          ? ` · Cuenta ${proyecciones.cuenta_real ? 'REAL' : 'DEMO'}${proyecciones.moneda ? ` (${proyecciones.moneda})` : ''}`
          : ' · Cuenta MT5 no disponible'}
      </Text>
      <Text style={styles.explanation}>
        {proyecciones.ejecucion_activa
          ? (proyecciones.todas_las_proyecciones
            ? 'Paso 9: AUTOMÁTICO · TODAS. El bot abre cada señal confirmada de todos tus activos. Aquí ves lo mismo con más detalle.'
            : 'Paso 9: AUTOMÁTICO · SOLO MARCADOS. El bot abre las señales confirmadas de los activos marcados Operar; las demás las puedes enviar tú con el botón de cada señal.')
          : 'Paso 9: SOLO AVISAR. SpotPlus no abre órdenes; puedes confirmar manualmente una señal válida.'}
        {!proyecciones.manual_permitido ? ' La entrada manual está bloqueada hasta que el escáner y MT5 estén listos y la cuenta cumpla la regla de demo.' : ''}
      </Text>
      {proyecciones.activos.map((activo) => (
        <View key={activo.simbolo} style={styles.saved}>
          <View style={styles.positionHeader}>
            <Text style={styles.savedTitle}>{activo.simbolo}</Text>
            <Text style={styles.badge}>{activo.marcado_operar ? 'OPERAR' : 'SEGUIR'}</Text>
          </View>
          <Text style={styles.explanation}>{activo.detalle}</Text>
          {activo.escenarios.length ? activo.escenarios.map((escenario) => {
            const compra = escenario.direccion === 'alcista';
            const id = `${activo.simbolo}:${escenario.clave}`;
            return <View key={escenario.clave} style={styles.position}>
              <Text style={[styles.badge, compra ? styles.buyBadge : styles.sellBadge]}>{compra ? 'COMPRA' : 'VENTA'} · {escenario.estado.toUpperCase()}</Text>
              <Text style={styles.explanation}>Zona {escenario.zona} · {escenario.zona_tf} ({escenario.zona_rango[0]}–{escenario.zona_rango[1]}) · {escenario.fuerza_rompimiento}</Text>
              <Text style={styles.muted}>Entrada ref. {escenario.entrada} · SL {escenario.sl} · Alineación {Math.round(escenario.alineacion * 100)}% · Confluencias {escenario.score}</Text>
              {escenario.operaciones.map((op) => {
                const lote = escenario.lotes.find((item) => item.operacion === op.nombre);
                return <Text key={op.nombre} style={styles.muted}>{op.nombre}: lote {lote?.lote ?? '—'} · TP {op.tp} · R:R {op.rr}</Text>;
              })}
              {escenario.confluencias.length ? <Text style={styles.muted}>Motivos: {escenario.confluencias.join(', ')}</Text> : null}
              {escenario.notas.map((nota) => <Text key={nota} style={styles.muted}>{nota}</Text>)}
              {escenario.en_curso ? <Text style={[styles.badge, styles.buyBadge]}>OPERACIÓN ABIERTA AHORA EN MT5</Text> : escenario.ejecutada ? <Text style={[styles.badge, styles.sellBadge]}>EJECUTADA ANTES · ESTA SEÑAL NO APARECE ABIERTA EN MT5</Text> : null}
              {proyecciones.manual_permitido && !escenario.ejecutada && escenario.estado === 'confirmada'
                ? <Button label={proyeccionOcupada === id ? 'Enviando orden…' : `Operar ${compra ? 'COMPRA' : 'VENTA'} manual`} onPress={() => !proyeccionOcupada && confirmarOperacionProyeccion(activo.simbolo, escenario.clave, escenario)} color="#237a4b" />
                : null}
            </View>;
          }) : <Text style={activo.estado === 'sin_datos' ? styles.error : styles.muted}>{activo.estado === 'sin_datos' || activo.estado === 'pendiente'
            ? activo.detalle
            : proyecciones.escaner.corriendo
              ? 'Sin oportunidad por ahora; SpotPlus vuelve a evaluar al cerrar la siguiente vela.'
              : 'No hay una proyección vigente; espera a que el escáner vuelva a ejecutarse.'}</Text>}
          {activo.posiciones.length ? <>
            <Text style={styles.subTitle}>OPERACIONES ABIERTAS</Text>
            {activo.posiciones.map((posicion) => <View key={posicion.ticket} style={styles.position}>
              <Text style={styles.value}>{posicion.tipo.toUpperCase()} · {posicion.volumen} lotes · Ticket {posicion.ticket}</Text>
              <Text style={styles.muted}>Entrada {posicion.precio_apertura} · Actual {posicion.precio_actual} · SL {posicion.sl || '—'} · TP {posicion.tp || '—'}</Text>
              <Text style={[styles.value, posicion.profit >= 0 ? styles.green : styles.red]}>Avance flotante: {posicion.profit.toFixed(2)} {proyecciones.moneda || ''}</Text>
            </View>)}
          </> : null}
        </View>
      ))}
    </> : <Text style={styles.muted}>Cargando proyecciones…</Text>}
    {proyeccionesMensaje ? <Text style={[styles.message, { backgroundColor: '#183b2a', color: '#70e0a3' }]}>{proyeccionesMensaje}</Text> : null}
    {proyeccionesError ? <Text style={styles.error}>{proyeccionesError}</Text> : null}
    <Button label="Actualizar proyecciones" onPress={cargarProyecciones} color="#303b48" />
  </Section>}
  {tab === 'estrategia' && <>
    <ListaActivos apiUrl={API_URL} apiKey={API_KEY} />
    <PanelAnalista apiUrl={API_URL} apiKey={API_KEY} />
  {false && <>
  <Section title="Bot"><View style={styles.rowButtons}><Button label={state?.config?.activo ? 'Pausar bot' : 'Reanudar bot'} onPress={() => run('/api/config', { activo: !(state?.config?.activo ?? true) }, 'Estado actualizado')} /></View></Section>
  <Section title="Estrategias guardadas">
    {!formAbierto ? <Button label="+ Agregar estrategia nueva" onPress={nuevaEstrategiaEnBlanco} color="#2563eb" /> : null}
    <Modal visible={formAbierto} animationType="slide" onRequestClose={resetFormularioEstrategia}>
      <View style={{ flex: 1, backgroundColor: '#0d1117' }}>
        <ScrollView contentContainerStyle={styles.content}>
          <Section title={editando ? `Editando estrategia: ${editando}` : 'Nueva estrategia'}>
            {editando ? (
              <View style={styles.saved}>
                <Text style={[styles.explanation, { color: '#e4b75a' }]}>Estás EDITANDO "{editando}". Los datos de abajo son de esa estrategia y, al guardar, se sobrescribe. Para crear una estrategia distinta, empieza una nueva en blanco.</Text>
                <Button label="Nueva estrategia en blanco" onPress={nuevaEstrategiaEnBlanco} color="#2563eb" />
              </View>
            ) : null}
    <Text style={styles.explanation}>Escribe aquí el script Python de cada estrategia. El código debe terminar asignando la variable `senal` con "compra", "venta" o None.</Text>
    <Field label="NOMBRE" value={name} onChangeText={setName} />
    <Field label="DESCRIPCIÓN" value={explanation} onChangeText={setExplanation} multiline />
    <Text style={[styles.label, { marginTop: 4 }]}>TEMPORALIDADES</Text>
    {savedTemporalidadesEscaneo.trim() ? (
      <Text style={[styles.explanation, { color: '#e4b75a' }]}>MODO ESCANEO: el código analiza las temporalidades que escribiste en "Temporalidades a escanear" y el bot decide cuál es la principal de cada señal. La entrada y la macro manuales no se usan. Para volver al modo manual, vacía ese campo.</Text>
    ) : (
      <>
        <Text style={styles.explanation}>MODO MANUAL: el script usará la temporalidad de entrada elegida. Activa la macro si tu código también necesita recibir `df_macro`. Si prefieres que el código use varias temporalidades a la vez, escríbelas en "Temporalidades a escanear" más abajo.</Text>
        <View style={styles.rowButtons}>
          <Field label="TEMPORALIDAD DE ENTRADA (ej. M15)" value={savedTfEntrada} onChangeText={setSavedTfEntrada} placeholder="M15" />
          <Field label="TEMPORALIDAD MACRO (ej. H1)" value={savedTfMacro} onChangeText={setSavedTfMacro} placeholder="H1" />
        </View>
        <View style={styles.rowButtons}>
          <Button label={savedUsaMultiTf ? 'Usar macro: ACTIVADO' : 'Usar macro: desactivado'} onPress={() => setSavedUsaMultiTf(!savedUsaMultiTf)} color={savedUsaMultiTf ? '#237a4b' : '#303b48'} />
        </View>
      </>
    )}
    <Text style={[styles.label, { marginTop: 10 }]}>ESCANEO MULTI-TEMPORALIDAD (avanzado)</Text>
    <Text style={styles.explanation}>Elige uno o varios marcos para escanear todas las oportunidades disponibles en ellos. El bot solo consulta y analiza los marcos seleccionados. "Todas" revisa las 11 temporalidades; "Manual" deja vacía la selección y usa la entrada/macro indicadas arriba.</Text>
    <View style={styles.rowButtons}>
      <Button
        label="Escanear todas"
        onPress={() => setSavedTemporalidadesEscaneo(TEMPORALIDADES_ESCANEO.join(', '))}
        color={new Set(savedTemporalidadesEscaneo.split(/[,\s]+/).map((tf) => tf.trim().toUpperCase()).filter(Boolean)).size === TEMPORALIDADES_ESCANEO.length ? '#237a4b' : '#303b48'}
      />
      <Button
        label="Modo manual"
        onPress={() => setSavedTemporalidadesEscaneo('')}
        color={!savedTemporalidadesEscaneo.trim() ? '#b88b35' : '#303b48'}
      />
    </View>
    <View style={styles.rowButtons}>
      {TEMPORALIDADES_ESCANEO.map((timeframe) => {
        const activa = savedTemporalidadesEscaneo
          .split(/[,\s]+/)
          .some((seleccionada) => seleccionada.trim().toUpperCase() === timeframe);
        return (
          <Button
            key={timeframe}
            label={timeframe}
            onPress={() => cambiarTemporalidadEscaneo(timeframe)}
            color={activa ? '#b88b35' : '#303b48'}
          />
        );
      })}
    </View>
    <Field label="TEMPORALIDADES A ESCANEAR (separadas por coma)" value={savedTemporalidadesEscaneo} onChangeText={setSavedTemporalidadesEscaneo} />
    <Text style={[styles.label, { marginTop: 10 }]}>ROL DE CADA GRUPO EN EL ESCANEO</Text>
    <View style={styles.rowButtons}>
      <Button label="Automático" onPress={() => {
        setEscaneoManual(false);
        setRolesTemporalidad({ micro: '', intermedia: '', macro: '', extra_macro: '' });
        setGruposTemporalidadTexto('');
        run('/api/config', { grupos_temporalidad: {} }, 'Escaneo automático: grupos por defecto');
      }} color={!escaneoManual ? '#237a4b' : '#303b48'} />
      <Button label="Manual" onPress={() => setEscaneoManual(true)} color={escaneoManual ? '#b88b35' : '#303b48'} />
    </View>
    <Text style={styles.explanation}>{escaneoManual ? 'Manual: tú eliges el rol de cada grupo y puedes mover una temporalidad a otro grupo.' : 'Automático: M1-M5 = micro (confirma), M15-H1 = intermedia (busca), H2-D1 = macro (busca), W1/MN1 = extra macro (contexto). Sin ajustes.'}</Text>
    <Text style={styles.explanation}>"Buscar" = ahí se detecta la zona y se puede abrir operación. "Confirmar" = solo valida el rompimiento (no abre su propia operación). "Contexto" = solo permite o bloquea según su dirección, nunca opera ahí (ideal para semanal/mensual). "No usar" = se ignora por completo.</Text>
    <Text style={styles.explanation}>Cada temporalidad cae por defecto en un grupo (M1-M5 = micro, M15-H1 = intermedia, H2-D1 = macro, W1/MN1 = extra macro). Si quieres que una de las tuyas se analice en OTRO grupo — por ejemplo, que M15 se trate como macro y no como intermedia — tócala abajo y cambia su grupo antes de asignarle el rol.</Text>
    {escaneoManual ? (() => {
      const escritas = Array.from(new Set(savedTemporalidadesEscaneo.split(/[,\s]+/).map((t) => t.trim().toUpperCase()).filter(Boolean)));
      const overrides = parseGruposTexto(gruposTemporalidadTexto);
      const noReconocidas = escritas.filter((t) => !GRUPO_TEMPORALIDAD[t] && !overrides[t]);
      const grupoDe = (tf: string) => overrides[tf] || GRUPO_TEMPORALIDAD[tf];
      const porGrupo: Record<string, string[]> = { micro: [], intermedia: [], macro: [], extra_macro: [] };
      escritas.forEach((t) => { const g = grupoDe(t); if (g && porGrupo[g]) porGrupo[g].push(t); });
      const cambiarGrupo = (tf: string, grupo: string) => {
        const esElDefecto = GRUPO_TEMPORALIDAD[tf] === grupo;
        const nuevo = { ...overrides };
        if (esElDefecto) delete nuevo[tf]; else nuevo[tf] = grupo;
        const texto = serializeGruposTexto(nuevo);
        setGruposTemporalidadTexto(texto);
        run('/api/config', { grupos_temporalidad: nuevo }, `${tf} ahora se analiza como ${grupo}`);
      };
      return (
        <>
          {noReconocidas.length ? <Text style={styles.error}>No reconozco: {noReconocidas.join(', ')} — revisa que estén separadas por coma y sean M1, M3, M5, M15, M30, H1, H2, H4, D1, W1 o MN1.</Text> : null}
          {(['micro', 'intermedia', 'macro', 'extra_macro'] as const).map((grupo) => (
            <View key={grupo} style={{ marginBottom: 10 }}>
              <Text style={styles.label}>{grupo.toUpperCase().replace('_', ' ')}{grupo === 'micro' ? ' (1-5m)' : grupo === 'intermedia' ? ' (15m-1h)' : grupo === 'macro' ? ' (2h-D1)' : ' (semanal/mensual)'}</Text>
              {porGrupo[grupo].length ? porGrupo[grupo].map((tf) => (
                <View key={tf} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <Text style={[styles.codeSummary, { marginBottom: 0, minWidth: 40 }]}>{tf}{overrides[tf] ? ' (cambiada)' : ''}</Text>
                  {(['micro', 'intermedia', 'macro', 'extra_macro'] as const).map((opcion) => (
                    <Button
                      key={opcion}
                      label={opcion === 'extra_macro' ? 'Extra macro' : opcion.charAt(0).toUpperCase() + opcion.slice(1)}
                      onPress={() => cambiarGrupo(tf, opcion)}
                      color={grupoDe(tf) === opcion ? '#b88b35' : '#303b48'}
                    />
                  ))}
                </View>
              )) : <Text style={styles.muted}>No escribiste ninguna temporalidad de este grupo</Text>}
              <View style={styles.rowButtons}>
                {(['buscar', 'confirmar', 'contexto', 'no_usar'] as const).map((rol) => (
                  <Button
                    key={rol}
                    label={rol === 'no_usar' ? 'No usar' : rol.charAt(0).toUpperCase() + rol.slice(1)}
                    onPress={() => setRolesTemporalidad({ ...rolesTemporalidad, [grupo]: rolesTemporalidad[grupo] === rol ? '' : rol })}
                    color={rolesTemporalidad[grupo] === rol ? '#b88b35' : '#303b48'}
                  />
                ))}
              </View>
            </View>
          ))}
        </>
      );
    })() : null}
    <Text style={[styles.label, { marginTop: 10 }]}>ZONAS DE ESPERA PERMITIDAS</Text>
    <Text style={styles.explanation}>
      {zonasPermitidas.length
        ? `Esta estrategia SOLO abre operación en las zonas ${ZONAS_ESPERA.filter((z) => zonasPermitidas.includes(z.id)).map((z) => z.nombre).join(', ')}. Las demás se ignoran.`
        : 'Automático: esta estrategia acepta cualquier zona que detecte. Selecciona una o varias para limitarla; esta elección es independiente de las demás estrategias.'}
    </Text>
    <View style={styles.rowButtons}>
      <Button label="Automático" onPress={() => setZonasPermitidas([])} color={zonasPermitidas.length === 0 ? '#237a4b' : '#303b48'} />
      {ZONAS_ESPERA.map((z) => (
        <Button
          key={z.id}
          label={z.nombre}
          onPress={() => setZonasPermitidas(zonasPermitidas.includes(z.id) ? zonasPermitidas.filter((x) => x !== z.id) : [...zonasPermitidas, z.id])}
          color={zonasPermitidas.includes(z.id) ? '#b88b35' : '#303b48'}
        />
      ))}
    </View>
    {ZONAS_ESPERA.map((z) => <Text key={z.id} style={styles.muted}>{z.nombre}: {z.ayuda}</Text>)}
    <Field label="CÓDIGO PYTHON" value={code} onChangeText={setCode} multiline code />
    <View style={styles.rowButtons}><Field label="STOP LOSS (puntos de precio)" value={savedSl} onChangeText={setSavedSl} numeric /><Field label="TAKE PROFIT" value={savedTp} onChangeText={setSavedTp} numeric /></View>
    <Field label="VOLUMEN (lotes fijos)" value={savedVolume} onChangeText={setSavedVolume} numeric placeholder="0.01" />
    {editando ? <Text style={[styles.explanation, { color: '#e4b75a' }]}>Editando "{editando}" — al guardar se sobrescribe (mismo nombre).</Text> : null}
    <Button label={editando ? 'Guardar cambios' : 'Guardar estrategia'} onPress={saveLibrary} color="#2563eb" />
    <Button label="Cancelar / cerrar formulario" onPress={resetFormularioEstrategia} color="#303b48" />
          </Section>
        </ScrollView>
      </View>
    </Modal>
    {saved.length ? <Button label="Borrar TODAS las estrategias" onPress={() => { if (typeof window !== 'undefined' && window.confirm('Esto borra TODAS las estrategias guardadas, incluidas las del backend. ¿Seguro?')) { run('/api/estrategias_guardadas', {}, 'Todas las estrategias borradas', 'DELETE'); } }} color="#8a2c2c" /> : null}
    {saved.map((item) => {
      const estaActiva = state?.config?.estrategia_biblioteca_activa === item.nombre;
      return <View style={styles.saved} key={item.nombre}><Text style={styles.savedTitle}>{item.nombre}</Text><Text style={styles.explanation}>{item.explicacion || 'Sin descripción'}</Text><Text style={styles.codeSummary}>Volumen: {item.volumen} lotes · SL {item.sl} · TP {item.tp}</Text><Text style={styles.codeSummary}>Entrada: {item.timeframe_entrada || 'M15'} · Macro: {item.timeframe_macro || 'H1'} · Usa macro: {item.usa_multi_temporalidad ? 'sí' : 'no'}</Text><View style={styles.rowButtons}><Button label={estaActiva ? 'Desactivar' : 'Activar'} onPress={() => estaActiva ? run('/api/estrategia/reset_total', {}, `${item.nombre} desactivada`) : run(`/api/estrategias_guardadas/activar/${encodeURIComponent(item.nombre)}`, {}, `${item.nombre} activada`)} color={estaActiva ? '#8a2c2c' : '#237a4b'} /><Button label="Ver código" onPress={() => exportarGuardada(item)} color="#2563eb" /><Button label="Editar" onPress={() => editarGuardada(item)} color="#b88b35" /><Button label="Borrar" onPress={() => run(`/api/estrategias_guardadas/${encodeURIComponent(item.nombre)}`, {}, `${item.nombre} borrada`, 'DELETE')} /></View></View>;
    })}
    {state?.config?.estrategia_biblioteca_activa ? <Text style={[styles.foot, { marginTop: 8 }]}>Activa: {state?.config?.estrategia_biblioteca_activa}</Text> : null}
  </Section>
  </>}
  </>}
  {tab === 'backtesting' && <>
  <Section wide title="Backtesting SpotPlus"><Text style={styles.explanation}>Es una simulación histórica, no son operaciones reales ni envía órdenes a MT5. No modela spread, comisión, swap ni deslizamiento del broker; solo representa gaps si una vela abre más allá del SL. Elige fechas disponibles en formato AAAA-MM-DD.</Text><View style={styles.rowButtons}><DateField label="DESDE" value={btFrom} onChangeText={setBtFrom} minDate={btDateRange?.desde} maxDate={btDateRange ? (btTo < btDateRange.hasta ? btTo : btDateRange.hasta) : undefined} disabled={!btDateRange} /><DateField label="HASTA" value={btTo} onChangeText={setBtTo} minDate={btDateRange ? (btFrom > btDateRange.desde ? btFrom : btDateRange.desde) : undefined} maxDate={btDateRange?.hasta} disabled={!btDateRange} /></View>{btDateError ? <Text style={styles.error}>{btDateError}</Text> : !btDateRange ? <Text style={styles.explanation}>Buscando las fechas con datos históricos disponibles...</Text> : <Text style={styles.explanation}>Datos disponibles: {btDateRange.desde} a {btDateRange.hasta}.</Text>}<Text style={styles.explanation}>Los precios históricos se obtienen de MetaTrader 5 y se completan con archivos CSV locales cuando hace falta. El lote se estima con el balance, el riesgo configurado y las especificaciones del símbolo disponibles; si MT5 no devuelve esos datos, el resultado avisa que son aproximados.</Text><Text style={styles.explanation}>El replay inicia en la temporalidad que requiere el intervalo de escaneo. Puedes cambiar el marco visible dentro del gráfico; las marcas muestran señales y operaciones simuladas conforme avanza.</Text><Field label="BALANCE INICIAL" value={btBalance} onChangeText={setBtBalance} numeric /><Button label={btRunning ? `Simulando... ${btProgress.toFixed(0)}%` : 'Correr backtest de SpotPlus'} onPress={runBacktest} color="#2563eb" />
  {btRunning ? <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${btProgress}%` }]} /></View> : null}
  {btResult && 'error' in btResult ? <Text style={styles.error}>{btResult.error}</Text> : null}
  {btResult && !('error' in btResult) ? <View style={styles.saved}>
    <Text style={styles.savedTitle}>{btResult.simbolo} · {btResult.desde} → {btResult.hasta}</Text>
    <View style={styles.row}><Text style={styles.label}>Balance final</Text><Text style={styles.value}>{btResult.balance_final} (inicial {btResult.balance_inicial})</Text></View>
    <View style={styles.row}><Text style={styles.label}>Ganancia total</Text><Text style={[styles.value, btResult.profit_total >= 0 ? styles.green : styles.red]}>{btResult.profit_total}</Text></View>
    <View style={styles.row}><Text style={styles.label}>Operaciones cerradas simuladas</Text><Text style={styles.value}>{btResult.total_operaciones} ({btResult.ganadoras} ganadoras / {btResult.perdedoras} perdedoras / {btResult.neutras ?? 0} break-even)</Text></View>
    <View style={styles.row}><Text style={styles.label}>Acierto sobre cerradas</Text><Text style={styles.value}>{btResult.tasa_acierto}%</Text></View>
    <View style={styles.row}><Text style={styles.label}>Drawdown máximo</Text><Text style={styles.value}>{btResult.max_drawdown}</Text></View>
    {btResult.posicion_abierta_al_final ? <View style={styles.position}><Text style={styles.value}>{btResult.posiciones_abiertas?.length || 1} POSICIÓN(ES) ABIERTA(S) AL FINAL · {btResult.posicion_abierta_al_final.tipo.toUpperCase()} · {btResult.posicion_abierta_al_final.entrada}</Text><Text style={styles.muted}>Flotante {btResult.posicion_abierta_al_final.profit_flotante ?? 0} · riesgo inicial {btResult.posicion_abierta_al_final.riesgo_real ?? '—'} / tope {btResult.posicion_abierta_al_final.riesgo_objetivo ?? '—'} · riesgo actual al SL {btResult.posicion_abierta_al_final.riesgo_actual ?? '—'} · No cuenta como operación cerrada</Text></View> : null}
    <Text style={styles.foot}>{btResult.velas_usadas} velas simuladas · Temporalidad evaluada {btResult.timeframe_entrada || '—'}</Text>
    {btResult.aviso ? <Text style={styles.foot}>{btResult.aviso}</Text> : null}
    {btResult.diagnostico ? <View style={styles.position}>
      <Text style={styles.subTitle}>DIAGNÓSTICO DE ESTRATEGIA</Text>
      <Text style={styles.muted}>Activa: {btResult.diagnostico.estrategia_activa} · {btResult.diagnostico.tipo_estrategia}</Text>
      <Text style={styles.muted}>Marcos configurados: {btResult.diagnostico.timeframes_configurados.join(', ') || 'ninguno'}</Text>
      <Text style={styles.muted}>Marcos recibidos: {btResult.diagnostico.timeframes_recibidos.join(', ') || 'ninguno'}</Text>
      {btResult.diagnostico.timeframes_faltantes.length ? <Text style={styles.red}>Falta histórico para: {btResult.diagnostico.timeframes_faltantes.join(', ')}</Text> : null}
      <Text style={styles.muted}>Evaluaciones: {btResult.diagnostico.evaluaciones_estrategia} · Señales: {btResult.diagnostico.senales_detectadas} · Oportunidades: {btResult.diagnostico.oportunidades_detectadas}</Text>
      <Text style={styles.muted}>Entradas simuladas: {btResult.diagnostico.entradas_ejecutadas} · Señales repetidas ignoradas: {btResult.diagnostico.senales_ignoradas_misma_direccion}</Text>
      {btResult.diagnostico.senales_detectadas === 0 ? <Text style={styles.foot}>{btResult.diagnostico.tipo_estrategia === 'ninguna' ? 'No hay una estrategia activa configurada para este backtest.' : `La estrategia se evaluó ${btResult.diagnostico.evaluaciones_estrategia} veces, pero no emitió señales de compra/venta en este rango.`}</Text> : null}
    </View> : null}
    <Button label="▶ Ver replay visual" onPress={() => setBtShowReplay(true)} color="#b88b35" />
    <Button label={btDisenoNuevo ? 'Diseño NUEVO · estructura por lentes · toca para anterior' : 'Diseño ANTERIOR · toca para nuevo'} onPress={() => setBtDisenoNuevo((v) => !v)} color="#303b48" />
    {btResult.operaciones.length ? <Text style={[styles.subTitle, { marginTop: 14 }]}>ÚLTIMAS OPERACIONES</Text> : null}
    {btResult.operaciones.slice(-15).reverse().map((t, i) => {
      const motivo = t.motivo_cierre || (t.be_aplicado && t.salida === t.entrada ? 'be' : t.salida === t.sl ? 'sl' : t.salida === t.tp ? 'tp' : 'cierre');
      const etiquetaMotivo = motivo === 'sl' ? 'STOP LOSS' : motivo === 'tp' ? 'TAKE PROFIT' : motivo === 'be' ? 'BREAKEVEN' : 'CIERRE';
      return <View style={styles.position} key={`${t.hora_cierre}-${i}`}><Text style={styles.value}>{t.tipo.toUpperCase()} · {t.entrada} → {t.salida} · {t.volumen} lotes</Text><Text style={[styles.muted, motivo === 'tp' || motivo === 'be' ? styles.green : styles.red]}>{etiquetaMotivo} · {t.profit >= 0 ? '+' : ''}{t.profit} · {t.hora_cierre}</Text><Text style={styles.muted}>Riesgo real {t.riesgo_real ?? '—'} / riesgo configurado {t.riesgo_objetivo ?? '—'}</Text></View>;
    })}
  </View> : null}
  </Section>
  {btShowReplay && btResult && !('error' in btResult) ? (
    btDisenoNuevo ? (
      <GraficoReplay velas={btResult.velas} operaciones={btResult.operaciones} posicionesAbiertas={btResult.posiciones_abiertas || []} valorPorUnidadLote={btResult.valor_por_unidad_lote || 0} simbolo={btResult.simbolo} desde={btResult.desde} hasta={btResult.hasta} indiceInicio={btResult.indice_inicio_replay} timeframeBase={btResult.timeframe_entrada || 'M5'} onClose={() => setBtShowReplay(false)}
        cargarVelas={async (tfx) => {
          const q = new URLSearchParams({ desde: btResult.desde, hasta: btResult.hasta, timeframe: tfx, simbolo: btResult.simbolo });
          const res = await api(`/api/backtest/velas?${q.toString()}`, ReplayVelasResponseSchema);
          if ('error' in res) throw new Error(res.error);
          return res.velas;
        }}
        cargarLentes={async () => {
          const q = new URLSearchParams({ desde: btResult.desde, hasta: btResult.hasta, simbolo: btResult.simbolo });
          return api(`/api/backtest/lentes?${q.toString()}`, LentesReplaySchema);
        }} />
    ) : (
    <ReplayBacktest velas={btResult.velas} operaciones={btResult.operaciones} pasosEstrategia={btResult.pasos_estrategia} diagnostico={btResult.diagnostico} simbolo={btResult.simbolo} desde={btResult.desde} hasta={btResult.hasta} indiceInicio={btResult.indice_inicio_replay} timeframeEntrada={btResult.timeframe_entrada || 'M5'} timeframeMacro={btResult.timeframe_macro} onClose={() => setBtShowReplay(false)} />
    )
  ) : null}
  </>}
  {tab === 'operar' && <>
  <Section title="Operar manualmente"><Text style={styles.label}>TIPO DE ORDEN</Text><View style={styles.rowButtons}><Button label="Mercado" onPress={() => setOrderType('mercado')} color={orderType === 'mercado' ? '#b88b35' : '#303b48'} /><Button label="Límite" onPress={() => setOrderType('limite')} color={orderType === 'limite' ? '#b88b35' : '#303b48'} /></View>{orderType === 'limite' ? <Field label="PRECIO DE ENTRADA" value={entryPrice} onChangeText={setEntryPrice} numeric /> : null}<View style={styles.rowButtons}><Field label="VOLUMEN" value={volume} onChangeText={setVolume} numeric /><Field label="STOP LOSS" value={sl} onChangeText={setSl} numeric /></View><Field label="TAKE PROFIT" value={tp} onChangeText={setTp} numeric /><View style={styles.rowButtons}><Button label={sendingOrder ? 'Enviando...' : 'Comprar'} onPress={() => order('compra')} color="#237a4b" /><Button label={sendingOrder ? 'Enviando...' : 'Vender'} onPress={() => order('venta')} color="#a84343" /></View><Text style={styles.orderHint}>La orden requiere confirmación y se envía a MetaTrader 5.</Text></Section>
  <Section title={`Posiciones abiertas (${positions.length})`}>{positions.length ? positions.map((item) => <Pressable style={styles.position} key={item.ticket} onPress={() => setPosicionSeleccionada(item)}><View style={styles.positionHeader}><Text style={[styles.badge, item.tipo === 'compra' ? styles.buyBadge : styles.sellBadge]}>{item.tipo.toUpperCase()}</Text><Text style={styles.positionName}>{item.simbolo} · {item.volumen} lotes</Text><Pressable onPress={() => run(`/api/cerrar/${item.ticket}`, {}, 'Posición cerrada')}><Text style={styles.close}>Cerrar</Text></Pressable></View><Text style={styles.muted}>Apertura {item.precio_apertura} · Actual {item.precio_actual} · P/L real: {item.profit} {account?.moneda || ''}</Text><Text style={styles.foot}>Toca para ver el motivo y contexto</Text></Pressable>) : <Text style={styles.muted}>Sin posiciones abiertas. Si el bot dice "CONFIRMADA — YA EJECUTADA" y aquí no aparece nada, revisa el mensaje de "Última orden del bot" arriba — seguro MT5 la rechazó (volumen mínimo, stops muy cerca, símbolo no visible, etc).</Text>}</Section>
  {posicionSeleccionada ? <Modal visible transparent animationType="slide" onRequestClose={() => setPosicionSeleccionada(null)}><Pressable style={{ flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.7)', justifyContent: 'center', padding: 20 }} onPress={() => setPosicionSeleccionada(null)}><Pressable style={{ backgroundColor: '#151b23', borderWidth: 1, borderColor: '#33404d', borderRadius: 8, padding: 18, maxWidth: 600, width: '100%', alignSelf: 'center' }} onPress={(event) => event.stopPropagation()}><Text style={styles.savedTitle}>Detalle de operación · {posicionSeleccionada.ticket}</Text><Text style={styles.explanation}>MT5 informa que esta operación está abierta. Entrada: {posicionSeleccionada.tipo.toUpperCase()} a {posicionSeleccionada.precio_apertura} · Precio actual: {posicionSeleccionada.precio_actual} · P/L: {posicionSeleccionada.profit} {account?.moneda || ''}</Text><Text style={styles.muted}>Abierta: {formatearHora12(posicionSeleccionada.hora_apertura)}</Text><Text style={styles.label}>CONTEXTO DE LA ESTRATEGIA</Text><Text style={styles.explanation}>Micro / entrada: {state?.config?.timeframe_entrada || 'no disponible'} · Macro: {state?.config?.timeframe_macro || 'no disponible'}</Text>{state?.ultima_orden && !state.ultima_orden.ok ? <Text style={styles.error}>Último intento rechazado por MT5: {state.ultima_orden.error || 'sin detalle'}</Text> : null}<Button label="Cerrar detalle" onPress={() => setPosicionSeleccionada(null)} color="#8a2c2c" /></Pressable></Pressable></Modal> : null}
  </>}
  {tab === 'riesgo' && <>
  <Section title="Gestión de riesgo · acciones manuales">
    <Text style={styles.explanation}>Estas acciones no se ejecutan automáticamente. Elige un símbolo y BUY o SELL; el servidor vuelve a filtrar las posiciones abiertas antes de operar. No cambian la regla automática de BE basada en estructura macro/micro.</Text>
    <Text style={styles.label}>SÍMBOLO</Text>
    {groupSymbols.length ? <View style={styles.rowButtons}>{groupSymbols.map((item) => <Button key={item} label={item} onPress={() => setGroupSymbol(item)} color={groupSymbol === item ? '#b88b35' : '#303b48'} />)}</View> : <Text style={styles.muted}>No hay posiciones abiertas para seleccionar un símbolo.</Text>}
    <Text style={styles.label}>DIRECCIÓN</Text>
    <View style={styles.rowButtons}>
      <Button label="BUY" onPress={() => setGroupSide('compra')} color={groupSide === 'compra' ? '#237a4b' : '#303b48'} />
      <Button label="SELL" onPress={() => setGroupSide('venta')} color={groupSide === 'venta' ? '#a84343' : '#303b48'} />
    </View>
    <Text style={styles.explanation}>Coincidencias actuales: {groupPositions.length} posición(es) · {groupPositions.reduce((sum, item) => sum + item.volumen, 0).toFixed(2)} lotes.</Text>
    <Field label="COLCHÓN PARA SL A BE (puntos del símbolo, mayor que cero)" value={groupBuffer} onChangeText={setGroupBuffer} numeric placeholder="Ej. 20" />
    <Text style={styles.muted}>El SL se calcula desde el precio de entrada, añadiendo el colchón para BUY o restándolo para SELL. No calcula ni garantiza cubrir comisión, swap o spread: consulta los costos de tu bróker. Si el mercado o el SL actual no permiten mejorar la protección, esa posición se omitirá y se explicará.</Text>
    <View style={styles.rowButtons}>
      <Button label={groupBusy ? 'Procesando...' : 'Mover SL de todas a BE + colchón'} onPress={() => confirmGroupAction('mover_sl')} color="#b88b35" />
      <Button label={groupBusy ? 'Procesando...' : 'Cerrar todas las seleccionadas'} onPress={() => confirmGroupAction('cerrar')} color="#8a2c2c" />
    </View>
    {groupResult ? <Text style={groupResult.ok ? styles.message : styles.error}>{groupResult.text}</Text> : null}
  </Section>
  <Section title="Circuit breaker y spread">
    <Text style={styles.explanation}>Si la pérdida del día llega al % configurado, el bot deja de abrir operaciones nuevas hasta mañana (las que ya están abiertas siguen con su SL/TP normal). El límite de spread evita que el bot abra justo cuando el spread se dispara por una noticia.</Text>
    {state?.circuito_disparado ? <Text style={styles.error}>🛑 Circuit breaker activado: el bot no abrirá operaciones nuevas hoy.</Text> : null}
    <View style={styles.rowButtons}><Button label={state?.config?.circuito_perdida_diaria_activo ? 'Circuit breaker: ACTIVADO' : 'Circuit breaker: desactivado'} onPress={() => run('/api/config', { circuito_perdida_diaria_activo: !(state?.config?.circuito_perdida_diaria_activo ?? false) }, 'Circuit breaker actualizado')} color={state?.config?.circuito_perdida_diaria_activo ? '#237a4b' : '#303b48'} /></View>
    <View style={styles.rowButtons}>
      <Field label="PÉRDIDA DIARIA MÁXIMA (% del balance)" value={perdidaDiariaPct} onChangeText={setPerdidaDiariaPct} numeric />
      <Field label="SPREAD MÁXIMO (puntos, 0 = sin límite)" value={spreadMaximo} onChangeText={setSpreadMaximo} numeric />
    </View>
    <Field label="MÁX. OPERACIONES ABIERTAS POR SÍMBOLO (0 = ilimitadas)" value={maxOperaciones} onChangeText={setMaxOperaciones} numeric />
    <Text style={styles.explanation}>Por defecto es 1: evita que una misma señal abra varias operaciones seguidas. La temporalidad de entrada y la macro de la estrategia activa se mantienen aunque MT5 muestre otro gráfico.</Text>
    <Button label="Guardar límites" onPress={() => run('/api/config', { circuito_perdida_diaria_pct: Number(perdidaDiariaPct) || 0, spread_maximo_puntos: Number(spreadMaximo) || 0, max_operaciones_por_simbolo: Math.max(0, Math.floor(Number(maxOperaciones) || 0)) }, 'Límites guardados')} color="#b88b35" />
  </Section>
  </>}
  {tab === 'historial' && <>
  <Section title="Estadísticas (últimos 30 días)">{estadisticas ? <>
    {[['Operaciones totales', String(estadisticas.total_operaciones)], ['Ganadoras', String(estadisticas.ganadoras)], ['Perdedoras', String(estadisticas.perdedoras)], ['Winrate', `${estadisticas.winrate_pct}%`], ['Ganancia total', `${estadisticas.ganancia_total} ${account?.moneda || ''}`], ['Mejor operación', `${estadisticas.mejor_operacion} ${account?.moneda || ''}`], ['Peor operación', `${estadisticas.peor_operacion} ${account?.moneda || ''}`], ['Profit factor', estadisticas.profit_factor != null ? String(estadisticas.profit_factor) : '—'], ['Racha actual', estadisticas.racha_actual > 0 ? `${estadisticas.racha_actual} ganadoras seguidas` : estadisticas.racha_actual < 0 ? `${Math.abs(estadisticas.racha_actual)} perdedoras seguidas` : 'sin racha']].map(([label, value]) => <View style={styles.row} key={label}><Text style={styles.label}>{label}</Text><Text style={styles.value}>{value}</Text></View>)}
  </> : <Text style={styles.muted}>Cargando estadísticas...</Text>}</Section>
  <Section wide title="Bitácora de operaciones (automática)">
    <Text style={styles.explanation}>Cada operación (del bot o manual) se registra sola: queda EN CURSO mientras está abierta y, al cerrar, se completa con el resultado final (TP, SL, BE o manual).</Text>
    {diarioStats && diarioStats.total.operaciones > 0 ? <View style={[styles.saved, { marginBottom: 10 }]}>
      <Text style={styles.savedTitle}>{diarioStats.total.operaciones} cerradas · winrate {diarioStats.total.winrate_pct}% · {diarioStats.total.profit} {account?.moneda || ''}</Text>
      <Text style={styles.explanation}>{Object.entries(diarioStats.por_resultado).map(([k, v]) => `${k}: ${v.operaciones} (${v.profit})`).join('  ·  ')}</Text>
      <Text style={styles.muted}>{Object.entries(diarioStats.por_origen).map(([k, v]) => `${k}: ${v.operaciones} ops, ${v.winrate_pct}%`).join('  ·  ')}</Text>
    </View> : null}
    {diario.length === 0 ? <Text style={styles.muted}>Todavía no hay operaciones registradas.</Text> : null}
    {diario.slice(0, 40).map((o) => { const enCurso = o.estado === 'en_curso'; const gano = (o.profit ?? 0) > 0; return <View style={styles.position} key={o.id}>
      <View style={styles.positionHeader}><Text style={[styles.badge, o.tipo === 'compra' ? styles.buyBadge : styles.sellBadge]}>{o.tipo.toUpperCase()}</Text><Text style={styles.positionName}>{o.simbolo} · {o.volumen} lotes</Text><Text style={{ color: enCurso ? '#e4b75a' : gano ? '#4cc38a' : '#e5646b', fontWeight: '700' }}>{enCurso ? 'EN CURSO' : `${o.resultado}${o.profit != null ? ` ${o.profit > 0 ? '+' : ''}${o.profit}` : ''}`}</Text></View>
      <Text style={styles.muted}>Entrada {o.entrada ?? '—'} · SL {o.sl ?? '—'} · TP {o.tp ?? '—'}{o.origen ? ` · ${o.origen}` : ''}</Text>
      <Text style={styles.muted}>Estimado: {o.perdida_estimada != null ? `-${o.perdida_estimada}` : '—'} / {o.ganancia_estimada != null ? `+${o.ganancia_estimada}` : '—'}{o.ratio_rr ? ` · R:R 1:${o.ratio_rr}` : ''}</Text>
      {!enCurso ? <Text style={styles.muted}>Cierre {o.precio_cierre ?? '—'} · {formatearHora12(o.hora_cierre ?? 0)}{o.duracion_seg != null ? ` · duró ${Math.round(o.duracion_seg / 60)} min` : ''}</Text> : <Text style={styles.muted}>Abierta {formatearHora12(o.hora_apertura)} · ticket {o.ticket}</Text>}
    </View>; })}
  </Section>
  <Section title="Notas personales">
    <Text style={styles.explanation}>Anota tus razones al entrar/salir de una operación, aprendizajes o errores a evitar.</Text>
    {bitacora.length > 0 && <Pressable onPress={borrarTodaLaBitacora} style={{ alignSelf: 'flex-end', marginBottom: 8 }}><Text style={styles.close}>Borrar todo</Text></Pressable>}
    <Field label="NUEVA NOTA" value={notaNueva} onChangeText={setNotaNueva} multiline />
    <Button label="Agregar a la bitácora" onPress={agregarNota} color="#2563eb" />
    {bitacora.map((item) => <View style={styles.position} key={item.id}><Text style={styles.value}>{item.nota}</Text><View style={styles.positionHeader}><Text style={styles.muted}>{formatearHora12(item.hora)}{item.ticket ? ` · ticket ${item.ticket}` : ''}</Text><Pressable onPress={() => borrarNota(item.id)}><Text style={styles.close}>Borrar</Text></Pressable></View></View>)}
  </Section>
  <Section title="Historial reciente">{history.slice(0, 20).map((item) => <View style={styles.position} key={item.ticket}><Text style={styles.value}>{item.tipo.toUpperCase()} · {item.simbolo} · {item.volumen} lotes</Text><Text style={styles.muted}>{formatearHora12(item.hora)} · {item.profit}</Text></View>)}</Section>
  </>}
  {tab === 'fundamentales' && <>
  <Section wide title="Calendario económico">
    <Text style={styles.explanation}>Calendario de la semana: NFP, IPC, tasas y demás noticias de alto impacto.</Text>
    <Text style={[styles.subTitle, { marginTop: 4 }]}>EN PROCESO</Text>
    {fundamentales.en_proceso.length ? fundamentales.en_proceso.map((ev, i) => (
      <View key={`proc-${i}`} style={{ backgroundColor: '#3c3020', borderRadius: 6, padding: 10, marginBottom: 8 }}>
        <Text style={{ color: '#e4b75a', fontWeight: '800' }}>🟡 {ev.title} ({ev.country || '--'})</Text>
        <Text style={styles.muted}>{formatearHoraEvento(ev.date)} · Publicándose ahora / esperando dato</Text>
      </View>
    )) : <Text style={styles.muted}>Ninguna saliendo en este momento.</Text>}

    <Text style={[styles.subTitle, { marginTop: 14 }]}>PENDIENTES ESTA SEMANA</Text>
    {fundamentales.pendientes.length ? fundamentales.pendientes.map((ev, i) => (
      <View key={`pend-${i}`} style={styles.position}>
        <Text style={styles.value}>{ev.title} ({ev.country || '--'})</Text>
        <Text style={styles.muted}>{formatearHoraEvento(ev.date)} · Alto impacto</Text>
      </View>
    )) : <Text style={styles.muted}>Sin más noticias de alto impacto pendientes esta semana.</Text>}

    <Text style={[styles.subTitle, { marginTop: 14 }]}>YA PUBLICADAS</Text>
    {fundamentales.pasados.length ? fundamentales.pasados.map((ev, i) => {
      if (ev.sin_dato) {
        return (
          <View key={`pas-${i}`} style={styles.position}>
            <Text style={styles.value}>{ev.title} ({ev.country || '--'})</Text>
            <Text style={styles.muted}>Sin dato publicado por la fuente</Text>
            <Text style={styles.foot}>{formatearHoraEvento(ev.date)}</Text>
          </View>
        );
      }
      const color = ev.sorpresa === 'mejor' ? styles.green : ev.sorpresa === 'peor' ? styles.red : styles.muted;
      const etiqueta = ev.sorpresa === 'mejor' ? 'Mejor de lo esperado' : ev.sorpresa === 'peor' ? 'Peor de lo esperado' : ev.sorpresa === 'en_linea' ? 'En línea' : 'Sin comparación';
      return (
        <View key={`pas-${i}`} style={styles.position}>
          <Text style={styles.value}>{ev.title} ({ev.country || '--'})</Text>
          <Text style={color as any}>{etiqueta} · Actual {String(ev.actual ?? '--')} / Pronóstico {String(ev.forecast ?? '--')}</Text>
          <Text style={styles.foot}>{formatearHoraEvento(ev.date)}</Text>
        </View>
      );
    }) : <Text style={styles.muted}>Todavía no hay noticias publicadas esta semana.</Text>}
  </Section>
  </>}
  {tab === 'telegram' && <>
  <Section title="Cómo crear tu bot de Telegram">
    <Text style={styles.explanation}>1. En Telegram, busca a <Text style={{ fontWeight: '800', color: '#e1e7ed' }}>@BotFather</Text> y mándale /newbot.{'\n'}2. Ponle un nombre y un usuario (debe terminar en "bot"). Te va a dar un TOKEN largo — cópialo aquí abajo.{'\n'}3. Abre un chat con el bot que acabas de crear (búscalo por el usuario que le pusiste) y mándale cualquier mensaje, ej. "hola".{'\n'}4. Busca a <Text style={{ fontWeight: '800', color: '#e1e7ed' }}>@userinfobot</Text> y mándale /start: te va a dar tu CHAT ID (un número). Pégalo aquí abajo.{'\n'}5. Guarda y toca "Probar" — deberías recibir un mensaje del bot en Telegram.</Text>
  </Section>
  <Section title="Configuración">
    <Field label="BOT TOKEN" value={tgToken} onChangeText={setTgToken} />
    <Field label="CHAT ID" value={tgChatId} onChangeText={setTgChatId} />
    <View style={styles.rowButtons}>
      <Button label={tgActivo ? 'Notificaciones ACTIVAS' : 'Notificaciones PAUSADAS'} onPress={() => setTgActivo(!tgActivo)} color={tgActivo ? '#237a4b' : '#303b48'} />
    </View>
    <Text style={[styles.label, { marginTop: 4 }]}>QUÉ AVISOS QUIERES RECIBIR</Text>
    <View style={styles.rowButtons}>
      <Button label="Apertura de operación" onPress={() => setTgAvisoApertura(!tgAvisoApertura)} color={tgAvisoApertura ? '#b88b35' : '#303b48'} />
      <Button label="Cierre de operación" onPress={() => setTgAvisoCierre(!tgAvisoCierre)} color={tgAvisoCierre ? '#b88b35' : '#303b48'} />
      <Button label="SL/TP" onPress={() => setTgAvisoSlTp(!tgAvisoSlTp)} color={tgAvisoSlTp ? '#b88b35' : '#303b48'} />
    </View>
    <View style={styles.rowButtons}>
      <Button label="Cierres parciales" onPress={() => setTgAvisoParcial(!tgAvisoParcial)} color={tgAvisoParcial ? '#b88b35' : '#303b48'} />
      <Button label="Zona esperando confirmación" onPress={() => setTgAvisoZona(!tgAvisoZona)} color={tgAvisoZona ? '#b88b35' : '#303b48'} />
    </View>
    <View style={styles.rowButtons}>
      <Button label="Guardar" onPress={guardarTelegram} color="#2563eb" />
      <Button label={tgProbando ? 'Enviando...' : 'Guardar y probar'} onPress={probarTelegram} color="#237a4b" />
    </View>
    <Text style={styles.foot}>Ahora sí puedes elegir avisos por SL/TP: el bot detecta cierres automáticos de MT5 y puede avisarte solo cuando la posición cierra por stop loss o take profit.</Text>
  </Section>
  </>}
           <Text style={styles.footer}>SpotPlus · Centro de control</Text>
         </ScrollView>
       </View>
     </View>
   </View>
  );
}

const baseStyles = StyleSheet.create({ screen: { flex: 1, backgroundColor: '#0d1117' }, content: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 28, maxWidth: 1120, width: '100%', alignSelf: 'center', gap: 14 }, contentGrid: { paddingHorizontal: 28, paddingTop: 24, paddingBottom: 32, maxWidth: 1920, width: '100%', alignSelf: 'center', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', alignContent: 'flex-start', gap: 16 }, contentGridCompact: { paddingHorizontal: 14, paddingTop: 16, paddingBottom: 24, gap: 12 }, center: { flex: 1, backgroundColor: '#0d1117', alignItems: 'center', justifyContent: 'center', gap: 14 }, header: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 14 }, resumen: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, flexGrow: 1, flexShrink: 1, flexBasis: 320, alignContent: 'flex-end' }, resumenChip: { backgroundColor: '#151b23', borderWidth: 1, borderColor: '#26303b', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, minWidth: 150 }, resumenValor: { color: '#f4f1e8', fontSize: 15, fontWeight: '800', marginTop: 3 }, kicker: { color: '#e4b75a', fontSize: 11, letterSpacing: 2, fontWeight: '700' }, title: { color: '#f4f1e8', fontSize: 40, fontWeight: '800', letterSpacing: -1 }, connection: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 20 }, online: { backgroundColor: '#183b2a' }, offline: { backgroundColor: '#3c2023' }, dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#57d391', marginRight: 7 }, connectionText: { color: '#d7e3db', fontSize: 12, fontWeight: '700' }, section: { backgroundColor: '#151b23', borderWidth: 1, borderColor: '#26303b', borderRadius: 12, padding: 20, flexGrow: 1, flexShrink: 1, flexBasis: 480, minWidth: 0 }, sectionWide: { flexBasis: '100%' }, sectionTitle: { color: '#f4f1e8', fontSize: 14, fontWeight: '800', letterSpacing: 0.4, marginBottom: 18 }, market: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 }, right: { alignItems: 'flex-end' }, symbol: { color: '#f4f1e8', fontSize: 28, fontWeight: '800', marginTop: 5 }, signal: { color: '#e4b75a', fontSize: 15, fontWeight: '800', marginTop: 6 }, metrics: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#26303b', paddingTop: 16 }, muted: { color: '#8893a0', fontSize: 11, letterSpacing: 0.5 }, metric: { color: '#dce2e8', fontSize: 15, fontWeight: '700' }, green: { color: '#57d391' }, red: { color: '#ff7d7d' }, row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#26303b' }, label: { color: '#8893a0', fontSize: 11, letterSpacing: 0.6, marginBottom: 6 }, value: { color: '#e1e7ed', fontSize: 14, fontWeight: '700' }, foot: { color: '#687481', fontSize: 11, marginTop: 13 }, field: { flex: 1, marginBottom: 10, minWidth: 120 }, input: { backgroundColor: '#0e141b', borderWidth: 1, borderColor: '#33404d', borderRadius: 6, color: '#f4f1e8', padding: 11, minHeight: 42 }, codeInput: { minHeight: 110, textAlignVertical: 'top', fontFamily: Platform.OS === 'web' ? 'monospace' : undefined }, rowButtons: { flexDirection: 'row', gap: 9, flexWrap: 'wrap' }, button: { flex: 1, borderRadius: 8, padding: 14, alignItems: 'center', marginBottom: 9, minWidth: 120 }, buttonText: { color: '#fff', fontSize: 13, fontWeight: '800' }, subTitle: { color: '#f4f1e8', fontSize: 13, fontWeight: '800', marginTop: 12, marginBottom: 8 }, explanation: { color: '#8893a0', fontSize: 12, lineHeight: 18, marginBottom: 10 }, condition: { backgroundColor: '#0e141b', borderWidth: 1, borderColor: '#33404d', borderRadius: 7, padding: 12, marginBottom: 10 }, conditionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 }, conditionTitle: { color: '#e1e7ed', fontSize: 13, fontWeight: '700', flex: 1 }, remove: { color: '#ff7d7d', fontSize: 12 }, saved: { borderTopWidth: 1, borderTopColor: '#33404d', paddingTop: 12, marginTop: 12 }, savedTitle: { color: '#f4f1e8', fontSize: 15, fontWeight: '800', marginBottom: 5 }, codeSummary: { color: '#687481', fontSize: 11, marginBottom: 9 }, position: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#26303b' }, positionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 }, badge: { paddingHorizontal: 7, paddingVertical: 4, borderRadius: 4, fontSize: 10, fontWeight: '800', color: '#e1e7ed' }, buyBadge: { backgroundColor: '#194b31', color: '#70e0a3' }, sellBadge: { backgroundColor: '#57292c', color: '#ff9999' }, positionName: { color: '#dce2e8', fontSize: 13, flex: 1, marginLeft: 8 }, close: { color: '#e4b75a', fontSize: 12, fontWeight: '800' }, message: { width: '100%', color: '#e4b75a', backgroundColor: '#322915', padding: 11, borderRadius: 6, marginBottom: 14 }, error: { width: '100%', color: '#ff9999', backgroundColor: '#3a2024', padding: 11, borderRadius: 6, marginBottom: 14 }, orderHint: { color: '#687481', fontSize: 11, marginTop: 2 }, footer: { width: '100%', color: '#596572', fontSize: 10, textAlign: 'center', marginVertical: 18 }, tabBar: { flexDirection: 'row', gap: 6, flexGrow: 1 }, tabButton: { flex: 1, minWidth: 108, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 8, alignItems: 'center', backgroundColor: '#151b23', borderWidth: 1, borderColor: '#26303b' }, tabButtonActive: { backgroundColor: '#b88b35', borderColor: '#b88b35' }, tabButtonText: { color: '#8893a0', fontSize: 12, fontWeight: '700' }, tabButtonTextActive: { color: '#0d1117' }, progressTrack: { height: 8, backgroundColor: '#0e141b', borderRadius: 4, overflow: 'hidden', marginBottom: 12, borderWidth: 1, borderColor: '#33404d' }, progressFill: { height: '100%', backgroundColor: '#e4b75a', borderRadius: 4 }, replayBar: { padding: 16, paddingBottom: 30, backgroundColor: '#151b23', borderTopWidth: 1, borderTopColor: '#26303b' },
  dateValue: { color: '#e1e7ed', fontSize: 14 }, dateModalBackdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.65)', justifyContent: 'center', alignItems: 'center', padding: 20 }, dateModal: { backgroundColor: '#151b23', borderRadius: 8, padding: 18, alignItems: 'center' }, timeframeButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, timeframeOption: { flexGrow: 1, flexBasis: '22%', minHeight: 40, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 7, borderWidth: 1, borderColor: '#33404d', borderRadius: 6, backgroundColor: '#0e141b' }, timeframeOptionActive: { backgroundColor: '#b88b35', borderColor: '#b88b35' }, timeframeOptionText: { color: '#8893a0', fontSize: 12, fontWeight: '800' }, timeframeOptionTextActive: { color: '#0d1117' }, replayHeader: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, backgroundColor: '#151b23', borderBottomWidth: 1, borderBottomColor: '#26303b' }, replayTitle: { color: '#f4f1e8', fontSize: 15, fontWeight: '800' }, replayHint: { color: '#8893a0', fontSize: 11, marginTop: 5 },
});
const styles = {
  ...baseStyles,
  ...StyleSheet.create({
    screen: { flex: 1, backgroundColor: '#0a1118' },
    contentGrid: { paddingHorizontal: 30, paddingTop: 28, paddingBottom: 42, maxWidth: 1680, width: '100%', alignSelf: 'center', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch', alignContent: 'flex-start', gap: 18 },
    contentGridCompact: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 32, gap: 13 },
    contentGridDesktop: { paddingHorizontal: 36, paddingTop: 34 },
    center: { flex: 1, backgroundColor: '#0a1118', alignItems: 'center', justifyContent: 'center', gap: 14 },
    appShell: { flex: 1, flexDirection: 'row' },
    appShellDesktop: { backgroundColor: '#0a1118' },
    sidebar: { width: 244, flexShrink: 0, paddingHorizontal: 16, paddingTop: 26, paddingBottom: 20, backgroundColor: '#0e1720', borderRightWidth: 1, borderRightColor: '#1d2b37' },
    brand: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 8, marginBottom: 34 },
    brandMark: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#d7ae5b' },
    brandMarkText: { color: '#101820', fontSize: 22, fontWeight: '900' },
    brandName: { color: '#f0f4f7', fontSize: 17, fontWeight: '800', letterSpacing: 0.1 },
    brandCaption: { color: '#8192a1', fontSize: 9, fontWeight: '800', letterSpacing: 1.6, marginTop: 3 },
    navCaption: { color: '#687a89', fontSize: 9, fontWeight: '800', letterSpacing: 1.3, marginHorizontal: 10, marginBottom: 10 },
    navList: { gap: 5 },
    navButton: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 44, paddingHorizontal: 9, borderRadius: 11, borderWidth: 1, borderColor: 'transparent' },
    navButtonActive: { backgroundColor: '#192631', borderColor: '#2c3b47' },
    navIcon: { width: 29, height: 29, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: '#17232d' },
    navIconActive: { backgroundColor: '#d7ae5b' },
    navIconText: { color: '#8fa0ad', fontSize: 9, fontWeight: '900', letterSpacing: 0.2 },
    navIconTextActive: { color: '#101820' },
    navLabel: { color: '#9aa9b5', fontSize: 12, fontWeight: '600' },
    navLabelActive: { color: '#f0f4f7', fontWeight: '800' },
    sidebarFooter: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 'auto', padding: 13, borderRadius: 13, backgroundColor: '#141f29', borderWidth: 1, borderColor: '#23313d' },
    statusIndicator: { width: 9, height: 9, borderRadius: 5 },
    statusIndicatorOnline: { backgroundColor: '#49c58b' },
    statusIndicatorOffline: { backgroundColor: '#ed7078' },
    sidebarStatusText: { color: '#e5ebf0', fontSize: 11, fontWeight: '800' },
    sidebarStatusSub: { color: '#8c9ca9', fontSize: 10, marginTop: 3 },
    main: { flex: 1, minWidth: 0 },
    header: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 18, marginBottom: 4 },
    headerCompact: { alignItems: 'flex-start', gap: 14 },
    titleGroup: { flexGrow: 1, flexShrink: 1, flexBasis: 190 },
    kicker: { color: '#c69a49', fontSize: 9, letterSpacing: 1.6, fontWeight: '800' },
    title: { color: '#f0f4f7', fontSize: 32, fontWeight: '800', letterSpacing: -0.8, marginTop: 6 },
    titleCompact: { fontSize: 27 },
    resumen: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 9, flexGrow: 1, flexShrink: 1, flexBasis: 480, maxWidth: 760 },
    resumenCompact: { flexBasis: '100%', maxWidth: undefined, justifyContent: 'flex-start' },
    resumenChip: { backgroundColor: '#111c26', borderWidth: 1, borderColor: '#23323e', borderRadius: 13, paddingVertical: 11, paddingHorizontal: 13, minWidth: 132, flexGrow: 1 },
    resumenValor: { color: '#e9eef2', fontSize: 14, fontWeight: '800', marginTop: 5 },
    muted: { color: '#93a2af', fontSize: 11, letterSpacing: 0.2 },
    metric: { color: '#e5edf2', fontSize: 15, fontWeight: '700' },
    label: { color: '#8d9eab', fontSize: 10, letterSpacing: 0.8, marginBottom: 6 },
    value: { color: '#e4ebf0', fontSize: 14, fontWeight: '700' },
    foot: { color: '#7d8e9b', fontSize: 11, lineHeight: 17, marginTop: 12 },
    connection: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: '#273741' },
    online: { backgroundColor: '#14291f', borderColor: '#24523b' },
    offline: { backgroundColor: '#2d1d23', borderColor: '#60343a' },
    dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
    dotOnline: { backgroundColor: '#49c58b' },
    dotOffline: { backgroundColor: '#ed7078' },
    connectionText: { color: '#d6e0e5', fontSize: 11, fontWeight: '800' },
    section: { backgroundColor: '#111b25', borderWidth: 1, borderColor: '#22313d', borderRadius: 15, padding: 20, flexGrow: 1, flexShrink: 1, flexBasis: 450, minWidth: 0 },
    sectionWide: { flexBasis: '100%' },
    sectionTitle: { color: '#e9eef2', fontSize: 14, fontWeight: '800', letterSpacing: 0.1, marginBottom: 15 },
    symbol: { color: '#f0f4f7', fontSize: 25, fontWeight: '800', marginTop: 5 },
    signal: { color: '#d7ae5b', fontSize: 14, fontWeight: '800', marginTop: 6 },
    metrics: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#263541', paddingTop: 16 },
    green: { color: '#53ce91' },
    red: { color: '#f17b83' },
    row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#24323e' },
    input: { backgroundColor: '#0c151d', borderWidth: 1, borderColor: '#2b3b48', borderRadius: 9, color: '#edf2f5', padding: 11, minHeight: 44 },
    button: { flex: 1, borderRadius: 10, padding: 13, alignItems: 'center', marginBottom: 9, minWidth: 120 },
    buttonText: { color: '#f8fafb', fontSize: 12, fontWeight: '800' },
    subTitle: { color: '#e7edf1', fontSize: 13, fontWeight: '800', marginTop: 12, marginBottom: 8 },
    explanation: { color: '#94a4b0', fontSize: 12, lineHeight: 19, marginBottom: 10 },
    condition: { backgroundColor: '#0d1720', borderWidth: 1, borderColor: '#2a3945', borderRadius: 10, padding: 12, marginBottom: 10 },
    conditionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    conditionTitle: { color: '#e4ebf0', fontSize: 13, fontWeight: '700', flex: 1 },
    saved: { borderTopWidth: 1, borderTopColor: '#2a3945', paddingTop: 14, marginTop: 14 },
    savedTitle: { color: '#edf2f5', fontSize: 15, fontWeight: '800', marginBottom: 5 },
    codeSummary: { color: '#8797a4', fontSize: 11, marginBottom: 9 },
    position: { paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#24323e' },
    positionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 8 },
    badge: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, fontSize: 10, fontWeight: '800', color: '#e4ebf0' },
    buyBadge: { backgroundColor: '#163b2b', color: '#69d8a1' },
    sellBadge: { backgroundColor: '#48242a', color: '#f18b91' },
    positionName: { color: '#dbe4e9', fontSize: 13, flex: 1, marginLeft: 2 },
    positionProfit: { fontSize: 12, fontWeight: '800' },
    close: { color: '#e0b15b', fontSize: 12, fontWeight: '800' },
    message: { width: '100%', color: '#e1be73', backgroundColor: '#292419', padding: 12, borderRadius: 10, marginBottom: 14 },
    error: { width: '100%', color: '#f29aa0', backgroundColor: '#2d1d23', padding: 12, borderRadius: 10, marginBottom: 14 },
    orderHint: { color: '#82929e', fontSize: 11, marginTop: 3 },
    footer: { width: '100%', color: '#637583', fontSize: 10, textAlign: 'center', marginVertical: 20 },
    tabScroll: { width: '100%', flexGrow: 0, marginBottom: 2 },
    tabBar: { flexDirection: 'row', gap: 7, flexGrow: 1 },
    tabButton: { flex: 1, minWidth: 102, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 10, alignItems: 'center', backgroundColor: '#111b25', borderWidth: 1, borderColor: '#243440' },
    tabButtonActive: { backgroundColor: '#d7ae5b', borderColor: '#d7ae5b' },
    tabButtonText: { color: '#9aa9b4', fontSize: 11, fontWeight: '700' },
    tabButtonTextActive: { color: '#111a22', fontWeight: '800' },
    progressTrack: { height: 8, backgroundColor: '#0c151d', borderRadius: 5, overflow: 'hidden', marginBottom: 12, borderWidth: 1, borderColor: '#2a3945' },
    progressFill: { height: '100%', backgroundColor: '#d7ae5b', borderRadius: 5 },
    replayBar: { padding: 16, paddingBottom: 30, backgroundColor: '#111b25', borderTopWidth: 1, borderTopColor: '#263541' },
    dateValue: { color: '#e2eaf0', fontSize: 14 },
    dateModalBackdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.72)', justifyContent: 'center', alignItems: 'center', padding: 20 },
    dateModal: { backgroundColor: '#111b25', borderWidth: 1, borderColor: '#2a3945', borderRadius: 14, padding: 18, alignItems: 'center' },
    timeframeButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
    timeframeOption: { flexGrow: 1, flexBasis: '22%', minHeight: 40, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8, borderWidth: 1, borderColor: '#2b3b48', borderRadius: 9, backgroundColor: '#0d1720' },
    timeframeOptionActive: { backgroundColor: '#d7ae5b', borderColor: '#d7ae5b' },
    timeframeOptionText: { color: '#a0afb9', fontSize: 12, fontWeight: '800' },
    timeframeOptionTextActive: { color: '#111a22' },
    replayHeader: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10, backgroundColor: '#111b25', borderBottomWidth: 1, borderBottomColor: '#263541' },
    replayTitle: { color: '#edf2f5', fontSize: 15, fontWeight: '800' },
    replayHint: { color: '#9aa9b4', fontSize: 11, marginTop: 5 },
    assetList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 5 },
    assetChip: { paddingVertical: 8, paddingHorizontal: 11, borderRadius: 8, backgroundColor: '#182631', borderWidth: 1, borderColor: '#2b3d49' },
    assetChipText: { color: '#dce6eb', fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
    operationalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#24323e' },
    operationalValue: { color: '#e7edf1', fontSize: 12, fontWeight: '800' },
    emptyState: { paddingVertical: 18, paddingHorizontal: 14, borderRadius: 11, backgroundColor: '#0d1720', borderWidth: 1, borderColor: '#21303b' },
    emptyTitle: { color: '#dce5ea', fontSize: 13, fontWeight: '800', marginBottom: 5 },
  }),
};