import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { STANDARD_DEVICES, type NetSnapshot } from '../board/board';
import type { DeviceSpec, DeviceState } from '../board/devices';
import { actions, currentExercise, useApp, type BoardView } from './store';
import { SchematicView } from './SchematicView';

const Board3D = lazy(() => import('./Board3D'));

export const LED_COLORS: Record<string, string> = {
  red: '#e5484d',
  yellow: '#f2b824',
  green: '#30c26b',
  blue: '#3b8ef0',
};

export function fmtFreq(hz: number): string {
  if (hz >= 1e6) return `${+(hz / 1e6).toPrecision(3)} MHz`;
  if (hz >= 1e3) return `${+(hz / 1e3).toPrecision(3)} kHz`;
  return `${+hz.toPrecision(3)} Hz`;
}

/** One-line electrical description of a net, for the technical layer. */
export function describeNet(n: NetSnapshot | undefined): string {
  if (!n) return 'not powered';
  if (n.contention) return 'short circuit: two outputs fight';
  if (n.floating) return 'floating (nothing drives it)';
  if (n.freq > 0.5 && n.duty > 0.001 && n.duty < 0.999) return `${fmtFreq(n.freq)}, ${Math.round(n.duty * 100)} % high`;
  if (n.v > 0.25 && n.v < 3.05) return `${n.v.toFixed(2)} V`;
  return n.level ? 'high (3.3 V)' : 'low (0 V)';
}

/** Devices fitted for the current project (static, so the board is visible before the first build). */
export function useSpecs(): DeviceSpec[] {
  const exercise = useApp((s) => currentExercise(s));
  return exercise ? STANDARD_DEVICES.filter((d) => exercise.devices.includes(d.id)) : STANDARD_DEVICES;
}

// ----------------------------------------------------------------- inputs

function useSyncedValue(external: number | undefined, fallback: number): [number, (v: number) => void, { onPointerDown(): void; onPointerUp(): void }] {
  const [value, setValue] = useState(external ?? fallback);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current && external !== undefined && Math.abs(external - value) > 1e-9) setValue(external);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external]);
  return [
    value,
    setValue,
    {
      onPointerDown: () => (dragging.current = true),
      onPointerUp: () => (dragging.current = false),
    },
  ];
}

function PressButton({ spec, state, compact }: { spec: DeviceSpec; state: DeviceState | undefined; compact?: boolean }) {
  const [held, setHeld] = useState(false);
  const set = (down: boolean) => {
    setHeld(down);
    actions.input(spec.id, 'pressed', down ? 1 : 0);
  };
  const pressed = held || state?.pressed === true;
  return (
    <button
      className={`push${pressed ? ' down' : ''}${compact ? ' compact' : ''}`}
      aria-pressed={pressed}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        set(true);
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) set(true);
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') set(false);
      }}
      title="Press and hold"
    >
      <span className="push-cap" />
      {compact && <span>{spec.label}</span>}
    </button>
  );
}

function Slider({
  spec, name, min, max, step, external, fallback, format,
}: {
  spec: DeviceSpec; name: string; min: number; max: number; step: number; external: number | undefined; fallback: number; format: (v: number) => string;
}) {
  const [value, setValue, drag] = useSyncedValue(external, fallback);
  return (
    <label className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={spec.label}
        {...drag}
        onChange={(e) => {
          const v = Number(e.target.value);
          setValue(v);
          actions.input(spec.id, name, v);
        }}
      />
      <output>{format(value)}</output>
    </label>
  );
}

/** The interactive control for an input device (null for outputs). */
export function DeviceControl({ spec, state, compact }: { spec: DeviceSpec; state: DeviceState | undefined; compact?: boolean }) {
  switch (spec.kind) {
    case 'button':
      return <PressButton spec={spec} state={state} compact={compact} />;
    case 'pot':
      return <Slider spec={spec} name="pos" min={0} max={1} step={0.005} external={state?.pos as number | undefined} fallback={0.5} format={(v) => `${Math.round(v * 100)} %`} />;
    case 'temp':
      return <Slider spec={spec} name="tempC" min={-10} max={60} step={0.5} external={state?.tempC as number | undefined} fallback={22} format={(v) => `${v.toFixed(1)} °C`} />;
    case 'ldr':
      return <Slider spec={spec} name="light" min={0} max={1} step={0.01} external={state?.light as number | undefined} fallback={0.5} format={(v) => `${Math.round(v * 100)} % light`} />;
    case 'hcsr04':
      return <Slider spec={spec} name="distanceCm" min={2} max={400} step={1} external={state?.distanceCm as number | undefined} fallback={50} format={(v) => `${Math.round(v)} cm`} />;
    case 'tmp102':
      return <Slider spec={spec} name="tempC" min={-25} max={100} step={0.5} external={state?.tempC as number | undefined} fallback={23.5} format={(v) => `${v.toFixed(1)} °C`} />;
    case 'accel':
      return (
        <>
          <Slider spec={spec} name="tiltX" min={-90} max={90} step={1} external={state?.tiltX as number | undefined} fallback={0} format={(v) => `tilt X ${Math.round(v)}°`} />
          <Slider spec={spec} name="tiltY" min={-90} max={90} step={1} external={state?.tiltY as number | undefined} fallback={0} format={(v) => `tilt Y ${Math.round(v)}°`} />
        </>
      );
    default:
      return null;
  }
}

const INPUT_KINDS = new Set(['button', 'pot', 'temp', 'ldr', 'hcsr04', 'tmp102', 'accel']);

function InputsStrip({ specs }: { specs: DeviceSpec[] }) {
  const devices = useApp((s) => s.frame?.board.devices);
  const inputs = specs.filter((d) => INPUT_KINDS.has(d.kind));
  if (inputs.length === 0) return null;
  return (
    <div className="inputs-strip" aria-label="Board inputs">
      {inputs.map((d) => (
        <div key={d.id} className={`input-cell${d.kind === 'button' ? ' input-button' : ''}`}>
          {d.kind !== 'button' && <span className="input-label">{d.label}</span>}
          <DeviceControl spec={d} state={devices?.[d.id]} compact />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------- device visuals

const SEG_SHAPES = [
  'M14 6h28l-4 5H18z', // a
  'M44 8l4 4v20l-4 3-4-4V13z', // b
  'M44 39l4 3v20l-4 4-4-5V43z', // c
  'M14 68h28l-4-5H18z', // d
  'M12 39l4 4v18l-4 5-4-4V42z', // e
  'M12 8l4 5v18l-4 4-4-3V12z', // f
  'M16 34.5l3-3h18l3 3-3 3H19z', // g
];

export function SevenSegSvg({ segments, size = 56 }: { segments: number[]; size?: number }) {
  return (
    <svg viewBox="0 0 64 74" width={size} height={(size * 74) / 64} className="sevenseg" role="img" aria-label="7-segment display">
      <rect x="1" y="1" width="62" height="72" rx="5" className="seg-body" />
      {SEG_SHAPES.map((d, i) => (
        <path key={i} d={d} className="seg" style={{ opacity: 0.1 + 0.9 * (segments[i] ?? 0) }} />
      ))}
      <circle cx="56" cy="66" r="3" className="seg" style={{ opacity: 0.1 + 0.9 * (segments[7] ?? 0) }} />
    </svg>
  );
}

function useBuzzerSound(freq: number, on: boolean, enabled: boolean): void {
  const audio = useRef<{ ctx: AudioContext; osc: OscillatorNode; gain: GainNode } | null>(null);
  useEffect(() => {
    if (!enabled) {
      if (audio.current) {
        audio.current.osc.stop();
        void audio.current.ctx.close();
        audio.current = null;
      }
      return;
    }
    if (!audio.current) {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      audio.current = { ctx, osc, gain };
    }
    const a = audio.current;
    a.gain.gain.setTargetAtTime(on ? 0.04 : 0, a.ctx.currentTime, 0.01);
    if (on) a.osc.frequency.setTargetAtTime(freq, a.ctx.currentTime, 0.005);
  }, [freq, on, enabled]);
  useEffect(
    () => () => {
      if (audio.current) {
        audio.current.osc.stop();
        void audio.current.ctx.close();
        audio.current = null;
      }
    },
    [],
  );
}

function DeviceVisual({ spec, state }: { spec: DeviceSpec; state: DeviceState | undefined }) {
  const [sound, setSound] = useState(false);
  const running = useApp((s) => s.frame?.state === 'running');
  const buzzFreq = spec.kind === 'buzzer' ? Number(state?.freq ?? 0) : 0;
  const buzzOn = spec.kind === 'buzzer' && state?.on === true && running;
  useBuzzerSound(buzzFreq, buzzOn, sound && spec.kind === 'buzzer');

  switch (spec.kind) {
    case 'led': {
      const b = Number(state?.brightness ?? 0);
      const color = LED_COLORS[String(spec.options?.color ?? 'green')];
      return (
        <div className="viz">
          <span className="led" style={{ ['--led' as string]: color, ['--b' as string]: b }} />
          <span className="viz-value">{b <= 0.004 ? 'off' : b >= 0.996 ? 'on' : `${Math.round(b * 100)} %`}</span>
        </div>
      );
    }
    case 'rgb': {
      const r = Number(state?.r ?? 0);
      const g = Number(state?.g ?? 0);
      const b = Number(state?.b ?? 0);
      const max = Math.max(r, g, b);
      const css = `rgb(${Math.round(255 * r)}, ${Math.round(255 * g)}, ${Math.round(255 * b)})`;
      return (
        <div className="viz">
          <span className="led" style={{ ['--led' as string]: css, ['--b' as string]: max > 0 ? 1 : 0 }} />
          <span className="viz-value">{max <= 0.004 ? 'off' : `R ${Math.round(r * 100)} G ${Math.round(g * 100)} B ${Math.round(b * 100)}`}</span>
        </div>
      );
    }
    case 'button':
      return (
        <div className="viz">
          <DeviceControl spec={spec} state={state} />
          <span className="viz-value">{state?.pressed ? 'pressed' : 'released'}</span>
        </div>
      );
    case 'pot':
    case 'temp':
    case 'ldr':
      return (
        <div className="viz viz-wide">
          <DeviceControl spec={spec} state={state} />
          <span className="viz-value">{state?.volts !== undefined ? `${Number(state.volts).toFixed(2)} V` : ''}</span>
        </div>
      );
    case 'hcsr04':
      return (
        <div className="viz viz-wide">
          <DeviceControl spec={spec} state={state} />
          <span className="viz-value">{state?.busy ? 'measuring' : `${Number(state?.measurements ?? 0)} pings`}</span>
        </div>
      );
    case 'servo': {
      const angle = Number(state?.angle ?? 90);
      return (
        <div className="viz">
          <svg viewBox="0 0 64 48" width="64" height="48" role="img" aria-label={`Servo at ${Math.round(angle)} degrees`}>
            <rect x="14" y="20" width="36" height="24" rx="3" className="part-body" />
            <circle cx="32" cy="20" r="7" className="part-hub" />
            <g transform={`rotate(${angle - 90} 32 20)`}>
              <rect x="30" y="2" width="4" height="20" rx="2" className="part-arm" />
            </g>
          </svg>
          <span className="viz-value">{state?.valid ? `${Math.round(angle)}°` : 'no signal'}</span>
        </div>
      );
    }
    case 'motor': {
      const speed = Number(state?.speed ?? 0);
      const abs = Math.abs(speed);
      return (
        <div className="viz">
          <svg viewBox="0 0 48 48" width="48" height="48" role="img" aria-label={`Motor at ${Math.round(speed * 100)} percent`}>
            <circle cx="24" cy="24" r="20" className="part-body" />
            <g
              className="rotor"
              style={{
                animationDuration: abs > 0.02 ? `${0.25 / abs}s` : '0s',
                animationDirection: speed < 0 ? 'reverse' : 'normal',
                animationPlayState: abs > 0.02 && running ? 'running' : 'paused',
              }}
            >
              <path d="M24 8v32M8 24h32" className="part-arm-line" />
              <circle cx="24" cy="24" r="4" className="part-hub" />
            </g>
          </svg>
          <span className="viz-value">{state?.brake ? 'brake' : abs < 0.01 ? 'stopped' : `${speed > 0 ? '' : '-'}${Math.round(abs * 100)} %`}</span>
        </div>
      );
    }
    case 'buzzer':
      return (
        <div className="viz">
          <svg viewBox="0 0 48 48" width="44" height="44" role="img" aria-label="Buzzer">
            <circle cx="24" cy="24" r="16" className="part-body" />
            <circle cx="24" cy="24" r="4" className="part-hub" />
            {state?.on && (
              <g className="waves">
                <path d="M41 14a16 16 0 0 1 0 20" />
                <path d="M7 14a16 16 0 0 0 0 20" />
              </g>
            )}
          </svg>
          <span className="viz-value">{state?.on ? fmtFreq(buzzFreq) : 'silent'}</span>
          <label className="mini-check">
            <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> sound
          </label>
        </div>
      );
    case 'sevenseg': {
      const segs = (state?.segments as number[] | undefined) ?? [0, 0, 0, 0, 0, 0, 0, 0];
      return (
        <div className="viz">
          <SevenSegSvg segments={segs} />
          <span className="viz-value">{segs.some((s) => s > 0.05) ? `shows "${String(state?.char ?? '?')}"` : 'blank'}</span>
        </div>
      );
    }
    case 'tmp102':
      return (
        <div className="viz viz-wide">
          <DeviceControl spec={spec} state={state} />
          <span className="viz-value">
            address 0x48{state ? ` · register 0x${Number(state.raw).toString(16).toUpperCase().padStart(4, '0')} · ${Number(state.reads)} reads` : ''}
          </span>
        </div>
      );
    case 'eeprom':
      return (
        <div className="viz viz-wide">
          <span className="viz-value viz-mono">{state ? String(state.head) : 'FF FF FF FF FF FF FF FF'}</span>
          <span className="viz-value">
            address 0x50 · first 8 bytes{state ? ` · ${Number(state.writes)} writes${state.busy ? ' · writing' : ''}` : ''}
          </span>
        </div>
      );
    case 'ledbar': {
      const leds = (state?.leds as number[] | undefined) ?? [0, 0, 0, 0, 0, 0, 0, 0];
      return (
        <div className="viz">
          <div className="ledrow" role="img" aria-label="Eight LEDs driven by the shift register">
            {[7, 6, 5, 4, 3, 2, 1, 0].map((i) => (
              <span key={i} className="led led-small" style={{ ['--led' as string]: '#e5484d', ['--b' as string]: leds[i] }} title={`Q${i}`} />
            ))}
          </div>
          <span className="viz-value">
            Q7..Q0 = {leds.slice().reverse().join('')}
            {state ? ` · 0x${Number(state.value).toString(16).toUpperCase().padStart(2, '0')}` : ''}
          </span>
        </div>
      );
    }
    case 'accel':
      return (
        <div className="viz viz-wide">
          <DeviceControl spec={spec} state={state} />
          <span className="viz-value">
            {state ? `X ${Number(state.x)}  Y ${Number(state.y)}  Z ${Number(state.z)} mg${state.enabled ? '' : ' · powered down'}` : 'X 0  Y 0  Z 1000 mg'}
          </span>
        </div>
      );
    case 'console':
      return (
        <div className="viz">
          <button className="btn btn-small" onClick={() => actions.setDock('serial')}>
            Open console
          </button>
          <span className="viz-value">115200 baud</span>
        </div>
      );
  }
}

function DevicesView({ specs }: { specs: DeviceSpec[] }) {
  const board = useApp((s) => s.frame?.board);
  const details = useApp((s) => s.details);
  const watch = useApp((s) => s.watch);
  if (specs.length === 0) {
    return <div className="board-empty">This exercise uses no board devices: everything happens inside the chip. Watch the Checks panel.</div>;
  }
  return (
    <div className="devices">
      {specs.map((d) => (
        <article key={d.id} className={`device device-${d.kind}`}>
          <header>
            <h3>{d.label}</h3>
            {details && <span className="ref">{d.ref}</span>}
          </header>
          <DeviceVisual spec={d} state={board?.devices[d.id]} />
          <footer>
            {Object.entries(d.pins).map(([role, pin]) => (
              <button
                key={pin}
                className={`pin-row${watch.includes(pin) ? ' watched' : ''}`}
                onClick={() => actions.toggleWatch(pin)}
                title={`${pin}: ${board?.nets[pin]?.config ?? 'not powered'}. Click to ${watch.includes(pin) ? 'stop tracing' : 'trace'} this pin.`}
              >
                <span className="pin-name">{pin}</span>
                {details && (
                  <span className="pin-tech">
                    {Object.keys(d.pins).length > 1 ? `${role} · ` : ''}
                    {describeNet(board?.nets[pin])}
                    {board?.nets[pin] ? ` · ${board.nets[pin].config}` : ''}
                  </span>
                )}
              </button>
            ))}
          </footer>
        </article>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ panel

const VIEWS: Array<[BoardView, string]> = [
  ['devices', 'Devices'],
  ['schematic', 'Schematic'],
  ['3d', '3D board'],
];

export function BoardPanel() {
  const view = useApp((s) => s.boardView);
  const details = useApp((s) => s.details);
  const powered = useApp((s) => !!s.frame);
  const specs = useSpecs();
  return (
    <section className="board">
      <div className="board-head">
        <div className="segmented" role="tablist" aria-label="Board view">
          {VIEWS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} onClick={() => actions.setBoardView(id)}>
              {label}
            </button>
          ))}
        </div>
        <label className="toggle" title="Show designators, pin configuration, voltages and frequencies">
          <input type="checkbox" checked={details} onChange={(e) => actions.setDetails(e.target.checked)} />
          <span>Details</span>
        </label>
      </div>
      <div className={`board-body view-${view}`}>
        {!powered && <div className="board-off">Board is powered off. Build and run to start it.</div>}
        {view === 'devices' && <DevicesView specs={specs} />}
        {view === 'schematic' && <SchematicView specs={specs} />}
        {view === '3d' && (
          <Suspense fallback={<div className="board-empty">Loading 3D view…</div>}>
            <Board3D specs={specs} />
          </Suspense>
        )}
      </div>
      {view !== 'devices' && <InputsStrip specs={specs} />}
    </section>
  );
}
