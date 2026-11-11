/**
 * Live schematic: the MCU symbol in the middle, inputs on the left, outputs on
 * the right. Wires are coloured by what is happening on the net right now.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { NetSnapshot } from '../board/board';
import type { DeviceSpec, DeviceState } from '../board/devices';
import { actions, useApp } from './store';
import { LED_COLORS, describeNet, fmtFreq } from './BoardPanel';

const W = 500;
const MCU_X0 = 195;
const MCU_X1 = 305;
const PITCH = 36;
const TOP = 34;

type Side = 'left' | 'right';

interface PinRow {
  pin: string;
  role: string;
  y: number;
}
interface Placed {
  spec: DeviceSpec;
  side: Side;
  rows: PinRow[];
}

const LEFT_KINDS = new Set(['button', 'pot', 'temp', 'ldr', 'hcsr04', 'console']);

function layout(specs: DeviceSpec[]): { placed: Placed[]; height: number } {
  const sides: Record<Side, DeviceSpec[]> = { left: [], right: [] };
  const rowsOf = (d: DeviceSpec) => Object.keys(d.pins).length;
  let seg: DeviceSpec | null = null;
  for (const d of specs) {
    if (d.kind === 'sevenseg') seg = d;
    else sides[LEFT_KINDS.has(d.kind) ? 'left' : 'right'].push(d);
  }
  const count = (s: Side) => sides[s].reduce((n, d) => n + rowsOf(d) + 0.5, 0);
  if (seg) sides[count('left') <= count('right') ? 'left' : 'right'].push(seg);

  const placed: Placed[] = [];
  let height = 0;
  for (const side of ['left', 'right'] as Side[]) {
    let y = TOP;
    for (const spec of sides[side]) {
      const needsHeadroom = spec.kind === 'button' && spec.options?.pullup === true;
      if (needsHeadroom) y += 10;
      const rows: PinRow[] = Object.entries(spec.pins).map(([role, pin], i) => ({ pin, role, y: y + i * PITCH }));
      placed.push({ spec, side, rows });
      y += rows.length * PITCH + PITCH * 0.45;
    }
    height = Math.max(height, y);
  }
  return { placed, height: Math.max(height + 6, 150) };
}

function netClass(n: NetSnapshot | undefined): string {
  if (!n) return 'off';
  if (n.contention) return 'short';
  if (n.floating) return 'float';
  if (n.freq > 0.5 && n.duty > 0.001 && n.duty < 0.999) return 'toggle';
  if (n.v > 0.25 && n.v < 3.05) return 'analog';
  return n.level ? 'high' : 'low';
}

/** Short tag for how the MCU has configured the pin. */
function modeTag(n: NetSnapshot | undefined): string {
  if (!n) return '';
  const c = n.config;
  if (c.includes('clock is off')) return 'no clk';
  if (c.startsWith('input')) return c.includes('pull-up') ? 'IN ↑' : c.includes('pull-down') ? 'IN ↓' : 'IN';
  if (c.startsWith('output')) return c.includes('open-drain') ? 'OUT od' : 'OUT';
  if (c.startsWith('analog')) return 'ADC';
  const m = /\(([A-Z0-9_]+)\)/.exec(c);
  return m ? m[1].replace('USART2_', 'U2 ').replace('_', ' ') : 'AF ?';
}

function shortNet(n: NetSnapshot | undefined): string {
  if (!n) return '';
  if (n.contention) return 'short!';
  if (n.floating) return 'floating';
  if (n.freq > 0.5 && n.duty > 0.001 && n.duty < 0.999) return `${fmtFreq(n.freq)} ${Math.round(n.duty * 100)}%`;
  return `${n.v.toFixed(2)} V`;
}

function Ground({ x, y }: { x: number; y: number }) {
  return (
    <g className="sym">
      <path d={`M${x} ${y}v7M${x - 7} ${y + 7}h14M${x - 4} ${y + 10}h8M${x - 1.5} ${y + 13}h3`} />
    </g>
  );
}

function valueText(spec: DeviceSpec, st: DeviceState | undefined): string {
  if (!st) return '';
  switch (spec.kind) {
    case 'pot': return `${Math.round(Number(st.pos) * 100)} %`;
    case 'temp': return `${Number(st.tempC).toFixed(1)} °C`;
    case 'ldr': return `${Math.round(Number(st.light) * 100)} % light`;
    case 'hcsr04': return `${Math.round(Number(st.distanceCm))} cm`;
    case 'servo': return st.valid ? `${Math.round(Number(st.angle))}°` : 'no signal';
    case 'motor': return st.brake ? 'brake' : `${Math.round(Number(st.speed) * 100)} %`;
    case 'buzzer': return st.on ? fmtFreq(Number(st.freq)) : 'silent';
    case 'sevenseg': return `"${String(st.char)}"`;
    case 'console': return '115200 Bd';
    default: return '';
  }
}

const PART: Partial<Record<DeviceSpec['kind'], string>> = {
  temp: 'MCP9700', hcsr04: 'HC-SR04', servo: 'SG90', motor: 'H-bridge', console: 'USB serial', sevenseg: '7-seg CC', rgb: 'RGB LED', ldr: 'LDR + 10k', buzzer: 'Piezo',
};

interface Tip {
  pin: string;
  title: string;
  x: number;
  y: number;
}

export function SchematicView({ specs }: { specs: DeviceSpec[] }) {
  const board = useApp((s) => s.frame?.board);
  const details = useApp((s) => s.details);
  const watch = useApp((s) => s.watch);
  const { placed, height } = useMemo(() => layout(specs), [specs]);
  const [tip, setTip] = useState<Tip | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  if (specs.length === 0) {
    return <div className="board-empty">This exercise uses no board devices: everything happens inside the chip. Watch the Checks panel.</div>;
  }

  const hover = (pin: string, title: string) => ({
    onMouseMove: (e: React.MouseEvent) => {
      const r = wrap.current!.getBoundingClientRect();
      setTip({ pin, title, x: e.clientX - r.left, y: e.clientY - r.top });
    },
    onMouseLeave: () => setTip(null),
  });

  const parts: ReactNode[] = [];
  const mcuPins: ReactNode[] = [];

  for (const { spec, side, rows } of placed) {
    const dir = side === 'right' ? 1 : -1;
    const edge = side === 'right' ? MCU_X1 : MCU_X0;
    const X = (dx: number) => edge + dir * dx;
    const st = board?.devices[spec.id];
    const anchor = side === 'right' ? 'start' : 'end';
    const first = rows[0];
    const lastRow = rows[rows.length - 1];

    // wires and MCU pin labels
    rows.forEach((row) => {
      const n = board?.nets[row.pin];
      const cls = netClass(n);
      const reach = spec.kind === 'led' ? 26 : spec.kind === 'button' ? 60 : spec.kind === 'pot' ? 78 : 50;
      parts.push(
        <g key={`w-${row.pin}`} className={`net ${cls}${watch.includes(row.pin) ? ' watched' : ''}`} onClick={() => actions.toggleWatch(row.pin)} {...hover(row.pin, `${row.pin} · ${spec.label}${rows.length > 1 ? ` ${row.role}` : ''}`)}>
          <line className="hit" x1={edge} y1={row.y} x2={X(reach)} y2={row.y} />
          <line className="wire" x1={edge} y1={row.y} x2={X(reach)} y2={row.y} />
          {watch.includes(row.pin) && <circle className="probe" cx={X(10)} cy={row.y} r="3" />}
          {details && (
            <text className="net-label" x={X(4)} y={row.y - 4} textAnchor={anchor}>
              {shortNet(n)}
            </text>
          )}
        </g>,
      );
      mcuPins.push(
        <g key={`p-${row.pin}`}>
          <text className="pin-label" x={side === 'right' ? MCU_X1 - 6 : MCU_X0 + 6} y={row.y + 3.5} textAnchor={side === 'right' ? 'end' : 'start'}>
            {row.pin}
          </text>
          {details && (
            <text className="pin-mode" x={side === 'right' ? MCU_X1 - 36 : MCU_X0 + 36} y={row.y + 3.5} textAnchor={side === 'right' ? 'end' : 'start'}>
              {modeTag(n)}
            </text>
          )}
        </g>,
      );
    });

    const labelY = first.y - 9;
    const title = details ? `${spec.ref} · ${spec.label}` : spec.label;

    if (spec.kind === 'led') {
      const y = first.y;
      const b = Number(st?.brightness ?? 0);
      const color = LED_COLORS[String(spec.options?.color ?? 'green')];
      parts.push(
        <g key={spec.id} className="sym">
          <rect x={Math.min(X(26), X(50))} y={y - 5} width="24" height="10" />
          <line x1={X(50)} y1={y} x2={X(64)} y2={y} />
          <polygon points={`${X(64)},${y - 7} ${X(64)},${y + 7} ${X(76)},${y}`} style={{ fill: color, fillOpacity: 0.12 + 0.88 * b, stroke: b > 0.02 ? color : undefined }} />
          <line x1={X(76)} y1={y - 7} x2={X(76)} y2={y + 7} style={{ stroke: b > 0.02 ? color : undefined }} />
          {b > 0.02 && <circle cx={X(70)} cy={y} r={13} style={{ fill: color, fillOpacity: 0.16 * b, stroke: 'none' }} />}
          <line x1={X(76)} y1={y} x2={X(92)} y2={y} />
          <Ground x={X(92)} y={y} />
          <text className="sym-label" x={X(104)} y={y + 4} textAnchor={anchor}>
            {details ? `${spec.ref} ${spec.label.replace(' LED', '')}` : spec.label}
          </text>
          {details && (
            <text className="sym-value" x={X(38)} y={y - 9} textAnchor="middle">
              330Ω
            </text>
          )}
        </g>,
      );
    } else if (spec.kind === 'button') {
      const y = first.y;
      const pressed = st?.pressed === true;
      const pull = spec.options?.pullup === true;
      const a = X(60);
      const b = X(84);
      parts.push(
        <g key={spec.id} className="sym">
          {pull && (
            <g>
              <circle className="dot" cx={X(34)} cy={y} r="2.2" />
              <line x1={X(34)} y1={y} x2={X(34)} y2={y - 6} />
              <rect x={X(34) - 4} y={y - 24} width="8" height="18" />
              <line x1={X(34)} y1={y - 24} x2={X(34)} y2={y - 29} />
              <line x1={X(34) - 6} y1={y - 29} x2={X(34) + 6} y2={y - 29} />
              <text className="sym-value" x={X(44)} y={y - 12} textAnchor={anchor}>
                {details ? '10k to 3V3' : '3V3'}
              </text>
            </g>
          )}
          <circle cx={a} cy={y} r="2.6" className="contact" />
          <circle cx={b} cy={y} r="2.6" className="contact" />
          <line x1={a} y1={y} x2={pressed ? b : b - dir * 3} y2={pressed ? y : y - 10} className={pressed ? 'lever closed' : 'lever'} />
          <line x1={b} y1={y} x2={X(98)} y2={y} />
          <Ground x={X(98)} y={y} />
          <rect
            className="press-zone"
            x={Math.min(X(52), X(104))}
            y={y - 16}
            width="52"
            height="34"
            rx="4"
            onPointerDown={(e) => {
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              actions.input(spec.id, 'pressed', 1);
            }}
            onPointerUp={() => actions.input(spec.id, 'pressed', 0)}
            onPointerCancel={() => actions.input(spec.id, 'pressed', 0)}
          >
            <title>Press and hold {spec.label}</title>
          </rect>
          <text className="sym-label" x={X(110)} y={y + 4} textAnchor={anchor}>
            {title}
          </text>
          {details && !pull && (
            <text className="sym-value" x={X(110)} y={y + 16} textAnchor={anchor}>
              no pull-up fitted
            </text>
          )}
        </g>,
      );
    } else if (spec.kind === 'pot') {
      const y = first.y;
      const pos = Number(st?.pos ?? 0.5);
      const wiperY = y;
      parts.push(
        <g key={spec.id} className="sym">
          <path d={`M${X(78)} ${wiperY}l${-dir * 6} -3.5v7z`} className="arrow" />
          <rect x={X(84) - 5} y={y - 13} width="10" height="26" />
          <rect x={X(84) - 5} y={y + 13 - 26 * pos} width="10" height={26 * pos} className="fill-level" />
          <line x1={X(84)} y1={y - 13} x2={X(84)} y2={y - 17} />
          <line x1={X(84) - 5} y1={y - 17} x2={X(84) + 5} y2={y - 17} />
          <line x1={X(84)} y1={y + 13} x2={X(84)} y2={y + 15} />
          <path d={`M${X(84) - 5} ${y + 15}h10`} />
          <text className="sym-label" x={X(96)} y={y + 1} textAnchor={anchor}>
            {title}
          </text>
          <text className="sym-value" x={X(96)} y={y + 13} textAnchor={anchor}>
            {valueText(spec, st)}
          </text>
        </g>,
      );
    } else {
      // generic module box with one stub per pin
      const y0 = first.y - 13;
      const h = lastRow.y - first.y + 26;
      const bx = Math.min(X(50), X(170));
      parts.push(
        <g key={spec.id} className="sym">
          <rect x={bx} y={y0} width="120" height={h} rx="2" className="module" />
          {rows.map((row) => (
            <text key={row.pin} className="pin-mode" x={X(55)} y={row.y + 3.5} textAnchor={anchor}>
              {rows.length > 1 || details ? row.role : ''}
            </text>
          ))}
          <text className="sym-label" x={bx + (dir === 1 ? 114 : 6)} y={first.y + (rows.length > 1 ? 3.5 : -1)} textAnchor={dir === 1 ? 'end' : 'start'}>
            {spec.label}
          </text>
          <text className="sym-value" x={bx + (dir === 1 ? 114 : 6)} y={first.y + (rows.length > 1 ? 16 : 10)} textAnchor={dir === 1 ? 'end' : 'start'}>
            {valueText(spec, st)}
          </text>
          {details && (
            <text className="sym-ref" x={bx + (dir === 1 ? 0 : 120)} y={y0 - 3} textAnchor={dir === 1 ? 'start' : 'end'}>
              {spec.ref} {PART[spec.kind] ?? ''}
            </text>
          )}
          {spec.kind === 'rgb' && (
            <circle
              cx={bx + (dir === 1 ? 100 : 20)}
              cy={lastRow.y}
              r="8"
              style={{
                fill: `rgb(${Math.round(255 * Number(st?.r ?? 0))}, ${Math.round(255 * Number(st?.g ?? 0))}, ${Math.round(255 * Number(st?.b ?? 0))})`,
                fillOpacity: Math.max(Number(st?.r ?? 0), Number(st?.g ?? 0), Number(st?.b ?? 0)) > 0.01 ? 1 : 0.08,
              }}
            />
          )}
        </g>,
      );
    }
    void labelY;
  }

  const tipNet = tip ? board?.nets[tip.pin] : undefined;

  return (
    <div className="schematic" ref={wrap}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="Schematic of the board with live net states">
        <rect x={MCU_X0} y={12} width={MCU_X1 - MCU_X0} height={height - 20} rx="3" className="mcu" />
        <text className="mcu-name" x={(MCU_X0 + MCU_X1) / 2} y={25} textAnchor="middle">
          {details ? 'U1 STM32F072RB' : 'STM32'}
        </text>
        {mcuPins}
        {parts}
      </svg>
      <div className="legend" aria-hidden="true">
        <span className="key high">high</span>
        <span className="key low">low</span>
        <span className="key toggle">switching</span>
        <span className="key analog">analog</span>
        <span className="key float">floating</span>
      </div>
      {tip && (
        <div className="tip" style={{ left: Math.min(tip.x + 12, (wrap.current?.clientWidth ?? 400) - 230), top: tip.y + 14 }}>
          <strong>{tip.title}</strong>
          <span>{describeNet(tipNet)}</span>
          {tipNet && <span className="tip-tech">{tipNet.config}</span>}
          <span className="tip-hint">{watch.includes(tip.pin) ? 'Click to stop tracing' : 'Click to trace this pin'}</span>
        </div>
      )}
    </div>
  );
}
