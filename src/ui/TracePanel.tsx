import { useEffect, useRef, useState } from 'react';
import { actions, traces, useApp } from './store';
import { Icon } from './App';

const WINDOWS: Array<[number, string]> = [
  [0.002, '2 ms'],
  [0.02, '20 ms'],
  [0.2, '200 ms'],
  [2, '2 s'],
  [10, '10 s'],
];

function fmtFreq(hz: number): string {
  if (hz >= 1e6) return `${+(hz / 1e6).toPrecision(4)} MHz`;
  if (hz >= 1e3) return `${+(hz / 1e3).toPrecision(4)} kHz`;
  return `${+hz.toPrecision(4)} Hz`;
}

function fmtSpan(sec: number): string {
  if (sec >= 1) return `${+sec.toPrecision(3)} s`;
  if (sec >= 1e-3) return `${+(sec * 1e3).toPrecision(3)} ms`;
  return `${+(sec * 1e6).toPrecision(3)} us`;
}

/** Index of the last point with t <= time (or -1). */
function lowerIndex(t: number[], time: number): number {
  let lo = 0;
  let hi = t.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function TracePanel() {
  const watch = useApp((s) => s.watch);
  const specs = useApp((s) => s.specs);
  const hasFrame = useApp((s) => !!s.frame);
  const [span, setSpan] = useState(0.2);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const pinLabels = new Map<string, string>();
  for (const d of specs) {
    for (const [role, pin] of Object.entries(d.pins)) {
      const many = Object.keys(d.pins).length > 1;
      // a pin shared by several bus devices is labelled by its bus role (SCL, MOSI, ...)
      if (pinLabels.has(pin)) pinLabels.set(pin, `${role.toUpperCase()} bus`);
      else pinLabels.set(pin, many ? `${d.label} ${role}` : d.label);
    }
  }
  const labelsKey = [...pinLabels.entries()].map((e) => e.join('=')).join(',');

  useEffect(() => {
    const cv = canvas.current!;
    const box = wrap.current!;
    let raf = 0;
    let alive = true;
    const draw = () => {
      if (!alive) return;
      const dpr = window.devicePixelRatio || 1;
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = `${w}px`;
        cv.style.height = `${h}px`;
      }
      const g = cv.getContext('2d')!;
      const css = getComputedStyle(document.documentElement);
      const col = (name: string) => css.getPropertyValue(name).trim();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.font = '11px ui-monospace, Consolas, monospace';
      const labelW = 150;
      const plotW = Math.max(10, w - labelW - 8);
      const rows = watch.length;
      const axisH = 18;
      const rowH = rows ? Math.max(26, Math.min(64, (h - axisH) / rows)) : 0;
      const tEnd = traces.now;
      const tStart = tEnd - span;
      const x = (t: number) => labelW + ((t - tStart) / span) * plotW;

      // time grid
      g.strokeStyle = col('--line');
      g.fillStyle = col('--faint');
      g.lineWidth = 1;
      const divisions = plotW < 340 ? 3 : 5;
      for (let i = 0; i <= divisions; i++) {
        const gx = Math.round(labelW + (plotW * i) / divisions) + 0.5;
        g.beginPath();
        g.moveTo(gx, 0);
        g.lineTo(gx, rows * rowH);
        g.stroke();
        const dt = span * (1 - i / divisions);
        g.textAlign = i === divisions ? 'right' : i === 0 ? 'left' : 'center';
        g.fillText(i === divisions ? 'now' : `-${fmtSpan(dt)}`, gx, rows * rowH + 13);
      }

      watch.forEach((pin, row) => {
        const top = row * rowH;
        const d = traces.data.get(pin);
        const yHigh = top + 6;
        const yLow = top + rowH - 6;
        const y = (v: number) => yLow - (Math.max(0, Math.min(3.3, v)) / 3.3) * (yLow - yHigh);
        g.strokeStyle = col('--line');
        g.beginPath();
        g.moveTo(0, Math.round(top + rowH) + 0.5);
        g.lineTo(w, Math.round(top + rowH) + 0.5);
        g.stroke();

        let rises = 0;
        let highTime = 0;
        let analog = false;
        let lastV = 0;
        if (d && d.t.length > 0) {
          const start = Math.max(0, lowerIndex(d.t, tStart));
          g.beginPath();
          let prevT = Math.max(tStart, d.t[start]);
          let prevV = d.v[start];
          g.moveTo(x(prevT), y(prevV));
          for (let i = start + 1; i < d.t.length; i++) {
            const t = d.t[i];
            const v = d.v[i];
            if (t < tStart) {
              prevV = v;
              continue;
            }
            if (v > 0.2 && v < 3.1) analog = true;
            g.lineTo(x(t), y(prevV));
            g.lineTo(x(t), y(v));
            if (prevV > 1.65) highTime += t - prevT;
            if (v > 1.65 && prevV <= 1.65) rises++;
            prevT = t;
            prevV = v;
          }
          if (prevV > 0.2 && prevV < 3.1) analog = true;
          g.lineTo(x(tEnd), y(prevV));
          if (prevV > 1.65) highTime += tEnd - prevT;
          lastV = prevV;
          g.strokeStyle = analog ? col('--analog') : col('--high');
          g.lineWidth = 1.5;
          g.stroke();
          g.lineWidth = 1;
        }

        g.textAlign = 'left';
        g.fillStyle = col('--text');
        g.fillText(pin, 8, top + 14);
        g.fillStyle = col('--muted');
        const label = pinLabels.get(pin);
        const twoLines = rowH >= 30;
        if (label && twoLines) g.fillText(label.length > 16 ? `${label.slice(0, 15)}…` : label, 44, top + 14);
        let stat: string;
        if (!d || d.t.length === 0) stat = 'no data yet';
        else if (analog) stat = `${lastV.toFixed(2)} V`;
        else if (rises >= 2) stat = `${fmtFreq(rises / span)}  ${Math.round((highTime / span) * 100)} %`;
        else stat = lastV > 1.65 ? 'high' : 'low';
        if (twoLines) g.fillText(stat, 8, top + 27);
        else g.fillText(stat, 44, top + 14);
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch, span, labelsKey]);

  const available = [...pinLabels.keys()].filter((p) => !watch.includes(p));

  return (
    <div className="trace">
      <div className="trace-bar">
        <div className="trace-chips">
          {watch.map((pin) => (
            <button key={pin} className="pin-chip" onClick={() => actions.toggleWatch(pin)} title={`Stop tracing ${pin}`}>
              {pin} <Icon name="cross" />
            </button>
          ))}
          {available.length > 0 && watch.length < 8 && (
            <select
              className="trace-add"
              value=""
              aria-label="Add a pin to the trace"
              onChange={(e) => {
                if (e.target.value) actions.toggleWatch(e.target.value);
              }}
            >
              <option value="">Add pin…</option>
              {available.map((p) => (
                <option key={p} value={p}>
                  {p} · {pinLabels.get(p)}
                </option>
              ))}
            </select>
          )}
        </div>
        <label className="select">
          <span>Window</span>
          <select value={span} onChange={(e) => setSpan(Number(e.target.value))}>
            {WINDOWS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="trace-plot" ref={wrap}>
        <canvas ref={canvas} role="img" aria-label="Waveforms of the traced pins" />
        {(!hasFrame || watch.length === 0) && (
          <div className="trace-empty">
            {watch.length === 0 ? 'Add a pin to see its waveform. Tip: click any wire in the schematic.' : 'Build and run to record the pins.'}
          </div>
        )}
      </div>
    </div>
  );
}
