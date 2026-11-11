/** Runs an exercise's checks against a compiled firmware image on a fresh simulated board. */
import { Board } from '../board/board';
import { Net } from '../board/net';
import { Mcu } from '../emu/mcu';
import { CheckContext, CheckResult, Exercise } from './types';

class Crash extends Error {}

export function runCheck(exercise: Exercise, elf: Uint8Array): CheckResult[] {
  const results: CheckResult[] = [];
  const mcu = new Mcu();
  const board = new Board(mcu, exercise.devices, exercise.deviceOptions);
  let crash: string | null = null;
  mcu.onFault = (f) => {
    const fn = mcu.functionAt(f.pc);
    crash = `${f.message}${fn ? ` (in ${fn})` : ''}`;
    mcu.cpu.stopRequested = true;
  };
  const ctx: CheckContext = {
    mcu,
    board,
    run(sec) {
      if (crash) throw new Crash(crash);
      mcu.runSeconds(sec);
      if (crash) throw new Crash(crash);
      if (mcu.cpu.halted === 'exit') throw new Crash('main() returned; on a microcontroller main must never return.');
      if (mcu.cpu.halted) throw new Crash(mcu.cpu.lastFault?.message ?? 'The CPU stopped.');
    },
    press(buttonId, holdMs = 80) {
      const b = board.button(buttonId);
      b.set(true);
      ctx.run(holdMs / 1000);
      b.set(false);
      ctx.run((b.bounceMs * 2 + 30) / 1000);
    },
    trace(pin): Net {
      const net = mcu.net(pin);
      if (!net.tracing) net.startTrace();
      return net;
    },
    global: (name, size) => mcu.readGlobal(name, size),
    serial: () => board.console?.text ?? '',
    expect(name, pass, detail) {
      results.push({ name, pass, detail });
    },
    hinted: (prefix) => mcu.hints.some((h) => h.id.startsWith(prefix)),
  };
  try {
    mcu.load(elf);
    exercise.check(ctx);
  } catch (e) {
    if (e instanceof Crash) results.push({ name: 'Program keeps running', pass: false, detail: e.message });
    else results.push({ name: 'Check could not complete', pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
  return results;
}

// ---------------------------------------------------------------- analysis

/** Times (seconds) of rising edges recorded on a traced net within [from, to]. */
export function rises(net: Net, from = 0, to = Infinity): number[] {
  const out: number[] = [];
  for (let i = 1; i < net.traceT.length; i++) {
    const t = net.traceT[i];
    if (t < from || t > to) continue;
    if (net.traceV[i] > 1.65 && net.traceV[i - 1] <= 1.65) out.push(t);
  }
  return out;
}

export function falls(net: Net, from = 0, to = Infinity): number[] {
  const out: number[] = [];
  for (let i = 1; i < net.traceT.length; i++) {
    const t = net.traceT[i];
    if (t < from || t > to) continue;
    if (net.traceV[i] <= 1.65 && net.traceV[i - 1] > 1.65) out.push(t);
  }
  return out;
}

/** Number of level changes within [from, to]. */
export function toggles(net: Net, from = 0, to = Infinity): number {
  return rises(net, from, to).length + falls(net, from, to).length;
}

export interface Wave {
  /** Mean frequency in Hz (0 if fewer than two rising edges). */
  freq: number;
  /** Mean high fraction over whole periods (0..1). */
  duty: number;
  /** Largest deviation of a single period from the mean, as a fraction. */
  jitter: number;
  /** Mean high-pulse width in seconds. */
  highSec: number;
  periods: number;
}

/** Frequency / duty of a periodic signal on a traced net within [from, to]. */
export function wave(net: Net, from = 0, to = Infinity): Wave {
  const r = rises(net, from, to);
  if (r.length < 2) return { freq: 0, duty: net.level, jitter: 0, highSec: 0, periods: 0 };
  const f = falls(net, r[0], r[r.length - 1]);
  const span = r[r.length - 1] - r[0];
  const mean = span / (r.length - 1);
  let jitter = 0;
  for (let i = 1; i < r.length; i++) jitter = Math.max(jitter, Math.abs(r[i] - r[i - 1] - mean) / mean);
  let high = 0;
  let n = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const fall = f.find((t) => t > r[i] && t <= r[i + 1]);
    if (fall !== undefined) {
      high += fall - r[i];
      n++;
    }
  }
  return { freq: 1 / mean, duty: high / span, jitter, highSec: n ? high / n : 0, periods: r.length - 1 };
}

export const near = (value: number, target: number, tolerance: number): boolean => Math.abs(value - target) <= tolerance;
export const fmt = (n: number, digits = 3): string => String(+n.toPrecision(digits));
