// Panel "Analista SpotPlus": configura backend/estrategia/config_estrategia.json desde la app.
// El analista SOLO avisa (Telegram); no abre operaciones. Cada opcion se explica en palabras simples.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

type Cfg = any; // la forma exacta la valida el backend (api_config.py)

const TFS = ['M1', 'M3', 'M5', 'M15', 'M30', 'H1', 'H2', 'H4', 'D1', 'W1'];
const TFS_MICRO = ['M1', 'M3', 'M5', 'M15'];

const DESC_ESTILO: Record<string, string> = {
  ninguno: 'SIN ESTILO: usa la configuración de abajo tal cual.',
  scalping: 'SCALPING: confirma en 1m/3m, solo zonas muy cerca del precio (1.5 ATR), una sola operación corta. Revisa cada 1 minuto.',
  intraday: 'INTRADAY: confirma en 5m, zonas hasta 3 ATR, la 2ª operación según el análisis. Revisa cada 5 minutos.',
  swing: 'SWING: confirma en 15m, exige 2 confluencias, solo la operación larga con R:R mínimo 2. Revisa cada 15 minutos.',
  position: 'POSITION: zonas en H4/D1, confirma en 1h, exige 2 confluencias, solo la larga con R:R mínimo 3. Revisa cada hora.',
};

function Interruptor({ label, ayuda, valor, onChange }: { label: string; ayuda?: string; valor: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable style={s.fila} onPress={() => onChange(!valor)}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={s.filaTitulo}>{label}</Text>
        {ayuda ? <Text style={s.ayuda}>{ayuda}</Text> : null}
      </View>
      <View style={[s.pastilla, valor ? s.pastillaOn : s.pastillaOff]}>
        <Text style={s.pastillaTexto}>{valor ? 'SÍ' : 'NO'}</Text>
      </View>
    </Pressable>
  );
}

function Opciones({ valor, opciones, onChange }: { valor: string; opciones: { id: string; texto: string }[]; onChange: (v: string) => void }) {
  return (
    <View style={s.opciones}>
      {opciones.map((o) => (
        <Pressable key={o.id} style={[s.opcion, valor === o.id && s.opcionActiva]} onPress={() => onChange(o.id)}>
          <Text style={[s.opcionTexto, valor === o.id && s.opcionTextoActivo]}>{o.texto}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ChipsTf({ valor, disponibles, onChange }: { valor: string[]; disponibles: string[]; onChange: (v: string[]) => void }) {
  return (
    <View style={s.opciones}>
      {disponibles.map((tf) => {
        const activo = valor.includes(tf);
        return (
          <Pressable key={tf} style={[s.chip, activo && s.opcionActiva]}
            onPress={() => {
              const nuevo = activo ? valor.filter((x) => x !== tf) : [...valor, tf];
              if (nuevo.length) onChange(nuevo); // siempre al menos una
            }}>
            <Text style={[s.opcionTexto, activo && s.opcionTextoActivo]}>{tf}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ChipUno({ valor, disponibles, onChange }: { valor: string; disponibles: string[]; onChange: (v: string) => void }) {
  return (
    <View style={s.opciones}>
      {disponibles.map((tf) => (
        <Pressable key={tf} style={[s.chip, valor === tf && s.opcionActiva]} onPress={() => onChange(tf)}>
          <Text style={[s.opcionTexto, valor === tf && s.opcionTextoActivo]}>{tf}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// Lente = en que temporalidad VES el grafico + de cual LEES la estructura (impulso / retroceso).
function Lentes({ lentes, onChange, sucio, onGuardar, aviso }: { lentes: Cfg; onChange: (ruta: string, v: unknown) => void; sucio: boolean; onGuardar: () => void; aviso: string }) {
  const lista: { nombre: string; vista: string; estructura: string }[] = lentes.lista || [];
  const guardarLista = (nueva: unknown) => onChange('temporalidades.lentes.lista', nueva);
  const cambiar = (i: number, campo: 'vista' | 'estructura', v: string) => {
    const nueva = lista.map((l, j) => (j === i ? { ...l, [campo]: v } : l));
    const l = nueva[i];
    if (TFS.indexOf(l.estructura) > TFS.indexOf(l.vista)) { // la estructura nunca puede ser mayor que la vista
      if (campo === 'vista') l.estructura = l.vista; else l.vista = l.estructura;
    }
    guardarLista(nueva);
  };
  return (
    <View>
      <Interruptor label="Lentes: ver en una temporalidad y leer la estructura en otra" ayuda="Cada lente tiene dónde VES el gráfico y de qué temporalidad LEES la estructura (impulso o retroceso). Si lentes vecinos coinciden se agrupan y da más confianza. Ej.: ves D1, estructura de 4h." valor={!!lentes.usar} onChange={(v) => onChange('temporalidades.lentes.usar', v)} />
      {lentes.usar ? (
        <>
          {lista.map((l, i) => (
            <View key={i} style={{ marginBottom: 12, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#1c2530' }}>
              <Text style={s.etiqueta}>LENTE {i + 1}: {l.nombre}  ({l.vista} / estructura {l.estructura})</Text>
              <Text style={s.etiqueta}>VES EN</Text>
              <ChipUno valor={l.vista} disponibles={TFS} onChange={(v) => cambiar(i, 'vista', v)} />
              <Text style={s.etiqueta}>ESTRUCTURA DE</Text>
              <ChipUno valor={l.estructura} disponibles={TFS.slice(0, TFS.indexOf(l.vista) + 1)} onChange={(v) => cambiar(i, 'estructura', v)} />
              {lista.length > 1 ? (
                <Pressable style={s.opcion} onPress={() => guardarLista(lista.filter((_, j) => j !== i))}>
                  <Text style={s.opcionTexto}>Quitar lente</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
          {lista.length < 20 ? (
            <Pressable style={s.opcion} onPress={() => guardarLista([...lista, { nombre: `lente ${lista.length + 1}`, vista: 'H1', estructura: 'M30' }])}>
              <Text style={s.opcionTexto}>+ Agregar lente</Text>
            </Pressable>
          ) : null}
          {lista.length < 20 ? (
            <Pressable style={s.opcion} onPress={() => {
              const micro = [
                { nombre: 'micro 15/5', vista: 'M15', estructura: 'M5' },
                { nombre: 'micro 5/3', vista: 'M5', estructura: 'M3' },
                { nombre: 'micro 3/1', vista: 'M3', estructura: 'M1' },
              ].filter((m) => !lista.some((l) => l.vista === m.vista && l.estructura === m.estructura));
              if (micro.length) guardarLista([...lista, ...micro].slice(0, 20));
            }}>
              <Text style={s.opcionTexto}>+ Lentes micro (M15/M5, M5/M3, M3/M1)</Text>
            </Pressable>
          ) : null}
          <Pressable style={[s.boton, { backgroundColor: sucio ? '#237a4b' : '#303b48', marginTop: 8, flex: 0 }]} onPress={onGuardar}>
            <Text style={s.botonTexto}>{sucio ? 'Guardar lentes' : 'Guardado'}</Text>
          </Pressable>
          {aviso ? <Text style={s.ayuda}>{aviso}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

function Numero({ label, valor, onChange, sufijo }: { label: string; valor: number; onChange: (v: number) => void; sufijo?: string }) {
  const [texto, setTexto] = useState(String(valor));
  useEffect(() => { setTexto(String(valor)); }, [valor]);
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={s.etiqueta}>{label}{sufijo ? ` (${sufijo})` : ''}</Text>
      <TextInput
        style={s.entrada}
        value={texto}
        keyboardType="decimal-pad"
        onChangeText={(t) => {
          setTexto(t);
          const n = parseFloat(t.replace(',', '.'));
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </View>
  );
}

function Bloque({ n, titulo, explicacion, children }: { n: number; titulo: string; explicacion: string; children: React.ReactNode }) {
  return (
    <View style={s.bloque}>
      <Text style={s.bloqueTitulo}>{n}. {titulo}</Text>
      <Text style={s.ayuda}>{explicacion}</Text>
      {children}
    </View>
  );
}

export function PanelAnalista({ apiUrl, apiKey }: { apiUrl: string; apiKey: string }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [mensaje, setMensaje] = useState('');
  const [error, setError] = useState('');
  const [sucio, setSucio] = useState(false);

  const llamar = useCallback(async (ruta: string, metodo = 'GET', cuerpo?: unknown) => {
    const r = await fetch(`${apiUrl}${ruta}`, {
      method: metodo,
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json.detail || `Servidor: ${r.status}`);
    return json;
  }, [apiUrl, apiKey]);

  const cargar = useCallback(async () => {
    try {
      setError('');
      const j = await llamar('/api/analista/config');
      setCfg(j.config);
      setSucio(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar. ¿Reiniciaste el backend con el parche aplicado?');
    }
  }, [llamar]);

  useEffect(() => { cargar(); }, [cargar]);

  // set('zonas_espera.tipos.flip', false)
  const poner = (ruta: string, valor: unknown) => {
    setCfg((prev: Cfg) => {
      const copia = JSON.parse(JSON.stringify(prev));
      const partes = ruta.split('.');
      let o = copia;
      partes.slice(0, -1).forEach((p) => { o = o[p]; });
      o[partes[partes.length - 1]] = valor;
      return copia;
    });
    setSucio(true);
    setMensaje('');
  };

  const guardar = async () => {
    try {
      setError('');
      const j = await llamar('/api/analista/config', 'POST', { config: cfg });
      setCfg(j.config);
      setSucio(false);
      setMensaje('Guardado. SpotPlus aplicará los cambios en su siguiente revisión.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    }
  };

  const restaurar = async () => {
    try {
      setError('');
      const j = await llamar('/api/analista/config/reset', 'POST', {});
      setCfg(j.config);
      setSucio(false);
      setMensaje('Valores originales restaurados.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo restaurar');
    }
  };

  if (!cfg) {
    return (
      <View style={s.seccion}>
        <Text style={s.titulo}>ESTRATEGIA SPOTPLUS</Text>
        {error ? <Text style={s.error}>{error}</Text> : <Text style={s.ayuda}>Cargando…</Text>}
        <Pressable style={[s.boton, { backgroundColor: '#2563eb' }]} onPress={cargar}><Text style={s.botonTexto}>Reintentar</Text></Pressable>
      </View>
    );
  }

  const t = cfg.temporalidades, d = cfg.direccion, z = cfg.zonas_espera, c = cfg.confirmacion,
    l = cfg.liquidez, cf = cfg.confluencias, o = cfg.operaciones, r = cfg.riesgo, est = cfg.estilo;

  return (
    <View style={s.seccion}>
      <Text style={s.titulo}>ESTRATEGIA SPOTPLUS</Text>
      <Text style={s.ayuda}>
        SpotPlus revisa tus activos al cierre de cada vela y puede avisarte por Telegram con zona, entrada, SL, TP y lote sugerido. El paso 9 define si solo avisa o también opera.
        Aquí eliges cómo trabaja. Cada opción explica qué significa “automático” y qué significa “manual”.
      </Text>
      {mensaje ? <Text style={s.mensaje}>{mensaje}</Text> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}

      {est ? (
        <Bloque n={0} titulo="Estilo de operativa" explicacion="Tu forma de operar. Al elegir un estilo, SpotPlus cambia por su cuenta las temporalidades de confirmación, qué tan cerca debe estar la zona, el tipo de operación y cada cuánto revisa. Mientras esté activo, pisa esos valores de abajo (el archivo no se modifica; al poner «Ninguno» vuelve todo a como lo tienes).">
          <Opciones valor={est.activo || 'ninguno'} onChange={(v) => poner('estilo.activo', v === 'ninguno' ? null : v)}
            opciones={[{ id: 'ninguno', texto: 'Ninguno' }, { id: 'scalping', texto: 'Scalping' }, { id: 'intraday', texto: 'Intraday' }, { id: 'swing', texto: 'Swing' }, { id: 'position', texto: 'Position' }]} />
          <Text style={s.ayuda}>{DESC_ESTILO[est.activo || 'ninguno']}</Text>
        </Bloque>
      ) : null}

      <Bloque n={1} titulo="Temporalidades" explicacion="Las temporalidades son los gráficos que revisa (1 minuto, 15 minutos, 4 horas…). AUTOMÁTICO: el bot usa todas y a cada una le da un trabajo (micro 1-5m confirma la entrada, intermedio 15m-1h busca zonas, macro 2h-4h y diario dan la dirección). MANUAL: solo revisa las que tú marques.">
        <Opciones valor={t.modo} onChange={(v) => poner('temporalidades.modo', v)} opciones={[{ id: 'auto', texto: 'Automático' }, { id: 'manual', texto: 'Manual' }]} />
        {t.modo === 'manual' ? <><Text style={s.etiqueta}>CUÁLES REVISAR</Text><ChipsTf valor={t.seleccion} disponibles={TFS} onChange={(v) => poner('temporalidades.seleccion', v)} /></> : null}
        <Interruptor label="Exigir alineación entre temporalidades" ayuda="Solo avisa si las temporalidades apuntan a la misma dirección (confluencia intertemporal)." valor={t.alineacion.usar} onChange={(v) => poner('temporalidades.alineacion.usar', v)} />
        {t.lentes ? <Lentes lentes={t.lentes} onChange={poner} sucio={sucio} onGuardar={guardar} aviso={error || mensaje} /> : null}
      </Bloque>

      <Bloque n={2} titulo="Dirección" explicacion="Hacia dónde va el precio: alcista (compras), bajista (ventas) o acumulación (rango, sin dirección). AUTOMÁTICO: el bot la detecta por la estructura. MANUAL: tú le dices la dirección y solo busca ese lado.">
        <Opciones valor={d.modo} onChange={(v) => poner('direccion.modo', v)} opciones={[{ id: 'auto', texto: 'Automática' }, { id: 'manual', texto: 'Manual' }]} />
        {d.modo === 'manual' ? <Opciones valor={d.manual} onChange={(v) => poner('direccion.manual', v)} opciones={[{ id: 'alcista', texto: 'Alcista' }, { id: 'bajista', texto: 'Bajista' }, { id: 'acumulacion', texto: 'Acumulación' }]} /> : null}
        <Interruptor label="Avisar también en acumulación" ayuda="Si está en NO, cuando el precio está en rango el bot no avisa nada." valor={d.operar_acumulacion} onChange={(v) => poner('direccion.operar_acumulacion', v)} />
      </Bloque>

      <Bloque n={3} titulo="Zonas de espera" explicacion="Son los precios donde esperas que el precio retroceda antes de continuar. Después de un rompimiento, el bot espera a que el precio regrese a una de estas zonas. Prende solo las que uses.">
        <Interruptor label="Usar zonas de espera" valor={z.usar} onChange={(v) => poner('zonas_espera.usar', v)} />
        {z.usar ? <>
          <Interruptor label="OBC (origen del movimiento)" ayuda="La zona donde nació el impulso. Para rompimientos débiles." valor={z.tipos.obc} onChange={(v) => poner('zonas_espera.tipos.obc', v)} />
          <Interruptor label="Flip (rompimiento medio)" ayuda="Un nivel roto que cambia de rol: la resistencia pasa a ser soporte." valor={z.tipos.flip} onChange={(v) => poner('zonas_espera.tipos.flip', v)} />
          <Interruptor label="Fibonacci 27 / 38 / 50" ayuda="Retroceso corto tras un rompimiento fuerte." valor={z.tipos.fibo} onChange={(v) => poner('zonas_espera.tipos.fibo', v)} />
          <Interruptor label="EV2 (110 / 127 / 138)" ayuda="Retroceso profundo: el precio pasa el origen, toma liquidez y vuelve (efecto catapulta)." valor={z.tipos.ev2} onChange={(v) => poner('zonas_espera.tipos.ev2', v)} />
          <Interruptor label="Nivel 88.6" ayuda="Se usa como confluencia: suma cuando coincide con una zona." valor={z.tipos.n886} onChange={(v) => poner('zonas_espera.tipos.n886', v)} />
          <Text style={s.etiqueta}>¿QUÉ ZONA USAR SEGÚN EL ROMPIMIENTO?</Text>
          <Text style={s.ayuda}>SEGÚN LA FUERZA: rompimiento fuerte → Fibonacci, medio → Flip, débil → OBC (como lo dibujaste). TODAS: acepta cualquier zona activa.</Text>
          <Opciones valor={z.modo} onChange={(v) => poner('zonas_espera.modo', v)} opciones={[{ id: 'por_fuerza', texto: 'Según la fuerza' }, { id: 'todas', texto: 'Todas' }]} />
          <Text style={s.etiqueta}>TEMPORALIDADES DONDE BUSCA ZONAS</Text>
          <Text style={s.ayuda}>AUTOMÁTICO: intermedias y macro. MANUAL: las que marques.</Text>
          <Opciones valor={z.tfs} onChange={(v) => poner('zonas_espera.tfs', v)} opciones={[{ id: 'auto', texto: 'Automático' }, { id: 'manual', texto: 'Manual' }]} />
          {z.tfs === 'manual' ? <ChipsTf valor={z.tfs_manual} disponibles={TFS.slice(3)} onChange={(v) => poner('zonas_espera.tfs_manual', v)} /> : null}
        </> : null}
      </Bloque>

      <Bloque n={4} titulo="Confirmación en micro" explicacion="Antes de avisar, espera que en un gráfico pequeño (1, 3 o 5 minutos) el precio confirme la entrada.">
        <Interruptor label="Usar confirmación" valor={c.usar} onChange={(v) => poner('confirmacion.usar', v)} />
        {c.usar ? <>
          <Text style={s.etiqueta}>QUÉ EXIGIR</Text>
          <Text style={s.ayuda}>ROMPIMIENTO: basta romper la estructura. DOS PUNTOS: rompe llevándose dos mínimos/máximos (más probabilidad). NADA: avisa al entrar a la zona sin esperar.</Text>
          <Opciones valor={c.exigir} onChange={(v) => poner('confirmacion.exigir', v)} opciones={[{ id: 'rompimiento', texto: 'Rompimiento' }, { id: 'dos_puntos', texto: 'Dos puntos' }, { id: 'ninguna', texto: 'Nada' }]} />
          <Text style={s.etiqueta}>TEMPORALIDADES MICRO</Text>
          <Text style={s.ayuda}>AUTOMÁTICO: revisa 1m, 3m y 5m. MANUAL: solo las que marques.</Text>
          <Opciones valor={c.micro_tfs} onChange={(v) => poner('confirmacion.micro_tfs', v)} opciones={[{ id: 'auto', texto: 'Automático' }, { id: 'manual', texto: 'Manual' }]} />
          {c.micro_tfs === 'manual' ? <ChipsTf valor={c.micro_manual} disponibles={TFS_MICRO} onChange={(v) => poner('confirmacion.micro_manual', v)} /> : null}
          <Text style={s.etiqueta}>SI VARIAS CONFIRMAN</Text>
          <Opciones valor={c.elegir} onChange={(v) => poner('confirmacion.elegir', v)} opciones={[{ id: 'mejor', texto: 'La mejor (SL más corto)' }, { id: 'primera', texto: 'La primera' }]} />
          {c.exigir_barrido_micro !== undefined ? <Interruptor label="Exigir barrido de liquidez antes de confirmar" ayuda="Solo confirma si, al entrar a la zona, el precio antes se llevó el último mínimo (compras) o máximo (ventas) y luego rompe. Es más estricto: da menos avisos." valor={c.exigir_barrido_micro} onChange={(v) => poner('confirmacion.exigir_barrido_micro', v)} /> : null}
        </> : null}
      </Bloque>

      <Bloque n={5} titulo="Liquidez" explicacion="La liquidez son los máximos y mínimos donde se acumulan stops. Puede servir de confluencia, de objetivo (TP) o para no entrar justo antes de que la barran.">
        <Interruptor label="Usar liquidez" valor={l.usar} onChange={(v) => poner('liquidez.usar', v)} />
        {l.usar ? <>
          <Interruptor label="Como confluencia" ayuda="Suma puntos al escenario si hay liquidez junto a la zona." valor={l.como_confluencia} onChange={(v) => poner('liquidez.como_confluencia', v)} />
          <Interruptor label="Como objetivo (TP)" ayuda="Pone el TP en la liquidez externa más cercana." valor={l.como_tp} onChange={(v) => poner('liquidez.como_tp', v)} />
          <Interruptor label="Evitar entrar antes del barrido" ayuda="Espera a que tome la liquidez y luego confirme." valor={l.evitar_entrada_antes_barrido} onChange={(v) => poner('liquidez.evitar_entrada_antes_barrido', v)} />
        </> : null}
      </Bloque>

      <Bloque n={6} titulo="Confluencias" explicacion="Cosas extra que apoyan el escenario (liquidez, nivel 88.6, dos puntos, alineación). Aquí decides cuántas necesita para avisar.">
        <Interruptor label="Exigir confluencias" valor={cf.usar} onChange={(v) => poner('confluencias.usar', v)} />
        {cf.usar ? <Numero label="MÍNIMO NECESARIO" valor={cf.minimo} onChange={(v) => poner('confluencias.minimo', Math.round(v))} /> : null}
      </Bloque>

      <Bloque n={7} titulo="Operaciones del aviso" explicacion="Cada aviso puede traer una operación corta (TP cercano) y otra que corre hacia un objetivo mayor.">
        <Opciones valor={o.modo} onChange={(v) => poner('operaciones.modo', v)} opciones={[{ id: 'analisis', texto: 'Según el análisis' }, { id: 'dos', texto: 'Siempre dos' }, { id: 'una', texto: 'Solo la corta' }, { id: 'solo_correr', texto: 'Solo la larga' }]} />
        <Text style={s.ayuda}>SEGÚN EL ANÁLISIS: pone la segunda operación solo si el escenario tiene suficientes confluencias (el mínimo de abajo).</Text>
        {o.modo === 'analisis' ? <Numero label="CONFLUENCIAS PARA DEJAR CORRER LA 2ª" valor={o.score_para_correr} onChange={(v) => poner('operaciones.score_para_correr', Math.round(v))} /> : null}
        {o.modo === 'analisis' || o.modo === 'dos' ? <>
          <Text style={s.etiqueta}>REPARTO DEL RIESGO: CORTA / LARGA</Text>
          <Opciones valor={String(Math.round(o.reparto[0] * 100))} onChange={(v) => poner('operaciones.reparto', [Number(v) / 100, 1 - Number(v) / 100])}
            opciones={['30', '40', '50', '60', '70'].map((x) => ({ id: x, texto: `${x}/${100 - Number(x)}` }))} />
        </> : null}
        {o.asegurar_en_retroceso !== undefined ? <Interruptor label="Asegurar ganancias si el marco mayor retrocede" ayuda="Si el marco mayor está en retroceso, deja solo la operación corta (no la deja correr). Así no te pones avaro en los retrocesos." valor={o.asegurar_en_retroceso} onChange={(v) => poner('operaciones.asegurar_en_retroceso', v)} /> : null}
      </Bloque>

      <Bloque n={8} titulo="Gestión de riesgo" explicacion="Cuánto arriesgas por escenario. El bot calcula el lote para que, si toca el SL, pierdas aproximadamente eso.">
        <Opciones valor={r.modo} onChange={(v) => poner('riesgo.modo', v)} opciones={[{ id: 'porcentaje', texto: '% del capital' }, { id: 'monto_fijo', texto: 'Cantidad fija' }]} />
        {r.modo === 'porcentaje' ? <>
          <Numero label="PORCENTAJE POR ESCENARIO" sufijo="%" valor={r.porcentaje} onChange={(v) => poner('riesgo.porcentaje', v)} />
          <Interruptor label="Interés compuesto" ayuda="SÍ: el % se calcula sobre tu balance actual (crece y baja con tus resultados). NO: siempre sobre el capital inicial de abajo." valor={r.interes_compuesto} onChange={(v) => poner('riesgo.interes_compuesto', v)} />
          {!r.interes_compuesto ? <Numero label="CAPITAL INICIAL" valor={r.capital_inicial} onChange={(v) => poner('riesgo.capital_inicial', v)} /> : null}
        </> : <Numero label="CANTIDAD POR ESCENARIO" sufijo="moneda de la cuenta" valor={r.monto_fijo} onChange={(v) => poner('riesgo.monto_fijo', v)} />}
      </Bloque>

      {cfg.ejecucion ? (
        <Bloque n={9} titulo="¿Solo avisar u operar?" explicacion="Elige qué hace SpotPlus cuando encuentra una entrada confirmada. Necesita el escáner corriendo (iniciar_escaner.bat).">
          <Opciones valor={cfg.ejecucion.activa ? 'operar' : 'avisar'} onChange={(v) => poner('ejecucion.activa', v === 'operar')} opciones={[{ id: 'avisar', texto: 'Solo avisar' }, { id: 'operar', texto: 'Operar automático' }]} />
          <Text style={s.ayuda}>
            {cfg.ejecucion.activa
              ? (cfg.ejecucion.todas_las_proyecciones
                ? 'AHORA: abre en MT5 (cuenta demo) TODAS las señales confirmadas de todos tus activos, con el lote, SL y TP del aviso, y además te avisa por Telegram.'
                : 'AHORA: abre en MT5 (cuenta demo) solo las señales confirmadas de los activos marcados «Operar». Las demás las eliges tú en Proyecciones.')
              : 'AHORA: solo te avisa por Telegram. Tú eliges en Proyecciones cuáles enviar.'}
          </Text>
          {cfg.ejecucion.activa ? <Interruptor label="Que el bot tome TODAS las proyecciones" ayuda="SÍ: ignora la marca «Operar» y abre cada señal confirmada de todos los activos que sigues. NO: solo los marcados «Operar»; el resto los envías tú desde Proyecciones." valor={!!cfg.ejecucion.todas_las_proyecciones} onChange={(v) => poner('ejecucion.todas_las_proyecciones', v)} /> : null}
          {cfg.ejecucion.activa ? <Numero label="MÁX. POSICIONES ABIERTAS POR SÍMBOLO (0 = sin límite)" valor={cfg.ejecucion.max_posiciones_por_simbolo} onChange={(v) => poner('ejecucion.max_posiciones_por_simbolo', Math.max(0, Math.floor(v)))} /> : null}
        </Bloque>
      ) : null}

      <View style={s.botones}>
        <Pressable style={[s.boton, { backgroundColor: sucio ? '#237a4b' : '#303b48' }]} onPress={guardar}><Text style={s.botonTexto}>{sucio ? 'Guardar cambios' : 'Guardado'}</Text></Pressable>
        <Pressable style={[s.boton, { backgroundColor: '#303b48' }]} onPress={cargar}><Text style={s.botonTexto}>Recargar</Text></Pressable>
        <Pressable style={[s.boton, { backgroundColor: '#8a2c2c' }]} onPress={restaurar}><Text style={s.botonTexto}>Valores originales</Text></Pressable>
      </View>
    </View>
  );
}

export function ListaActivos({ apiUrl, apiKey }: { apiUrl: string; apiKey: string }) {
  const [seguir, setSeguir] = useState<string[]>([]);
  const [operar, setOperar] = useState<string[]>([]);
  const [ejecucionActiva, setEjecucionActiva] = useState(false);
  const [nuevo, setNuevo] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [error, setError] = useState('');
  const [estadoAct, setEstadoAct] = useState<any>(null);

  const llamar = useCallback(async (metodo: string, cuerpo?: unknown) => {
    const r = await fetch(`${apiUrl}/api/analista/watchlist`, {
      method: metodo,
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json.detail || `Servidor: ${r.status}`);
    return json;
  }, [apiUrl, apiKey]);

  const cargar = useCallback(async () => {
    try {
      setError('');
      const j = await llamar('GET');
      setSeguir(j.simbolos);
      setOperar(j.operar);
      setEjecucionActiva(!!j.ejecucion_activa);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar la lista. ¿Reiniciaste el backend?');
    }
  }, [llamar]);

  const cargarEstado = useCallback(async () => {
    try {
      const r = await fetch(`${apiUrl}/api/analista/activos/estado`, { headers: { 'X-API-Key': apiKey } });
      if (r.ok) setEstadoAct(await r.json());
    } catch { /* se reintenta solo */ }
  }, [apiUrl, apiKey]);

  useEffect(() => { cargar(); cargarEstado(); const t = setInterval(cargarEstado, 30000); return () => clearInterval(t); }, [cargar, cargarEstado]);

  // Guarda al instante; si falla, vuelve a lo anterior y avisa.
  const guardar = async (nuevosSeguir: string[], nuevosOperar: string[]) => {
    const antes = { seguir, operar };
    setSeguir(nuevosSeguir);
    setOperar(nuevosOperar);
    setMensaje('');
    setError('');
    try {
      const j = await llamar('POST', { simbolos: nuevosSeguir, operar: nuevosOperar });
      setSeguir(j.simbolos);
      setOperar(j.operar);
      setMensaje('Guardado. El escáner lo toma en su siguiente vuelta.');
      cargarEstado();
    } catch (e) {
      setSeguir(antes.seguir);
      setOperar(antes.operar);
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    }
  };

  const agregar = () => {
    const sim = nuevo.trim().toUpperCase();
    if (!sim || seguir.includes(sim)) { setNuevo(''); return; }
    setNuevo('');
    guardar([...seguir, sim], operar);
  };

  return (
    <View style={s.seccion}>
      <Text style={s.titulo}>MIS ACTIVOS</Text>
      <Text style={s.ayuda}>
        SEGUIR: SpotPlus lo revisa y te avisa por Telegram. OPERAR: además puede abrir órdenes en MT5.
        Se guarda al tocar; si recargas la página verás lo mismo.
      </Text>
      <Text style={[s.mensaje, { backgroundColor: ejecucionActiva ? '#183b2a' : '#322915', color: ejecucionActiva ? '#70e0a3' : '#e4b75a' }]}>
        {ejecucionActiva
          ? 'Paso 9: OPERAR AUTOMÁTICO. Los activos marcados "Operar" pueden abrir órdenes con el escáner activo, una señal confirmada y las condiciones de MT5 válidas.'
          : 'Paso 9: SOLO AVISAR. Aunque marques "Operar", no se abre nada hasta que lo cambies en el paso 9.'}
      </Text>
      {estadoAct ? (
        <Text style={[s.mensaje, estadoAct.escaner?.corriendo
          ? { backgroundColor: '#183b2a', color: '#70e0a3' }
          : { backgroundColor: '#3b1a1a', color: '#ff9999' }]}>
          {estadoAct.escaner?.corriendo
            ? `Escáner CORRIENDO · última vuelta hace ${estadoAct.escaner.hace_min} min.`
            : 'ESCÁNER APAGADO: no se avisa ni se abre nada. Ejecuta iniciar_escaner.bat'}
          {estadoAct.cuenta_real ? '  · Cuenta REAL' : ''}
          {`\nAbrirán órdenes: ${estadoAct.resumen.abriran} · Solo avisan: ${estadoAct.resumen.solo_avisan} · En espera: ${estadoAct.resumen.en_espera} · Con problema: ${estadoAct.resumen.con_problema}`}
        </Text>
      ) : null}
      {mensaje ? <Text style={s.mensaje}>{mensaje}</Text> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Text style={s.etiqueta}>SIGUIENDO: {seguir.length} · OPERANDO: {operar.length}</Text>
      {seguir.map((sim) => {
        const operando = operar.includes(sim);
        return (
          <View key={sim} style={[s.fila, { flexWrap: 'wrap', gap: 8 }]}>
            <View style={{ flex: 1, minWidth: 140 }}>
              <Text style={s.filaTitulo}>{sim}</Text>
              {(() => {
                const a = estadoAct?.activos?.find((x: any) => x.simbolo === sim);
                if (!a) return null;
                const color = a.estado === 'opera' ? '#70e0a3' : a.estado === 'seguir' ? '#9aa7b4' : a.estado === 'ocupado' || a.estado === 'cerrado' ? '#e4b75a' : '#ff9999';
                return <Text style={{ fontSize: 11, color, marginTop: 2 }}>{a.detalle}</Text>;
              })()}
            </View>
            <View style={s.opciones}>
              <Pressable style={[s.opcion, !operando && s.opcionActiva]} onPress={() => operando && guardar(seguir, operar.filter((x) => x !== sim))}>
                <Text style={[s.opcionTexto, !operando && s.opcionTextoActivo]}>Seguir</Text>
              </Pressable>
              <Pressable style={[s.opcion, operando && { backgroundColor: '#237a4b', borderColor: '#237a4b' }]} onPress={() => !operando && guardar(seguir, [...operar, sim])}>
                <Text style={[s.opcionTexto, operando && { color: '#fff' }]}>Operar</Text>
              </Pressable>
              <Pressable style={s.opcion} onPress={() => guardar(seguir.filter((x) => x !== sim), operar.filter((x) => x !== sim))}>
                <Text style={s.opcionTexto}>Quitar</Text>
              </Pressable>
            </View>
          </View>
        );
      })}
      <Text style={s.etiqueta}>AGREGAR ACTIVO (nombre como lo escribe tu broker, ej. XAUUSD)</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput style={[s.entrada, { flex: 1 }]} value={nuevo} onChangeText={setNuevo} autoCapitalize="characters" placeholder="XAUUSD" placeholderTextColor="#55606d" onSubmitEditing={agregar} />
        <Pressable style={[s.boton, { flex: 0, minWidth: 100, backgroundColor: '#b88b35' }]} onPress={agregar}><Text style={s.botonTexto}>Agregar</Text></Pressable>
      </View>
      <View style={s.botones}>
        <Pressable style={[s.boton, { backgroundColor: '#303b48' }]} onPress={() => { cargar(); cargarEstado(); }}><Text style={s.botonTexto}>Recargar</Text></Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  seccion: { backgroundColor: '#111b25', borderWidth: 1, borderColor: '#22313d', borderRadius: 15, padding: 20, flexGrow: 1, flexShrink: 1, flexBasis: 480, minWidth: 0 },
  titulo: { color: '#e9eef2', fontSize: 14, fontWeight: '800', letterSpacing: 0.5, marginBottom: 14 },
  bloque: { borderTopWidth: 1, borderTopColor: '#2a3945', paddingTop: 15, marginTop: 15 },
  bloqueTitulo: { color: '#d7ae5b', fontSize: 14, fontWeight: '800', marginBottom: 7 },
  ayuda: { color: '#94a4b0', fontSize: 12, lineHeight: 19, marginBottom: 10 },
  etiqueta: { color: '#8d9eab', fontSize: 10, letterSpacing: 0.8, marginTop: 7, marginBottom: 7 },
  fila: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#24323e' },
  filaTitulo: { color: '#e1e8ed', fontSize: 13, fontWeight: '700' },
  pastilla: { minWidth: 48, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 14, alignItems: 'center' },
  pastillaOn: { backgroundColor: '#1b6946' },
  pastillaOff: { backgroundColor: '#293845' },
  pastillaTexto: { color: '#f7fafb', fontSize: 11, fontWeight: '800' },
  opciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  opcion: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 9, backgroundColor: '#0d1720', borderWidth: 1, borderColor: '#2a3945' },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#0d1720', borderWidth: 1, borderColor: '#2a3945' },
  opcionActiva: { backgroundColor: '#d7ae5b', borderColor: '#d7ae5b' },
  opcionTexto: { color: '#a0afb9', fontSize: 12, fontWeight: '700' },
  opcionTextoActivo: { color: '#111a22' },
  entrada: { backgroundColor: '#0c151d', borderWidth: 1, borderColor: '#2b3b48', borderRadius: 9, color: '#edf2f5', padding: 11, minHeight: 44 },
  botones: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 18 },
  boton: { flex: 1, minWidth: 120, borderRadius: 9, padding: 13, alignItems: 'center' },
  botonTexto: { color: '#f8fafb', fontSize: 12, fontWeight: '800' },
  mensaje: { color: '#e1be73', backgroundColor: '#292419', padding: 12, borderRadius: 10, marginBottom: 12 },
  error: { color: '#f29aa0', backgroundColor: '#2d1d23', padding: 12, borderRadius: 10, marginBottom: 12 },
});
