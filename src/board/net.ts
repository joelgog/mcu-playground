/**
 * Electrical nets: the wires between MCU pins and board devices.
 *
 * Every participant (an MCU pin, a button, a sensor...) can drive a net strongly
 * (a push-pull output, a switch to GND, an analog source) and/or weakly (a pull
 * resistor). The net resolves these into one voltage and one digital level.
 */
import { Clock } from '../emu/clock';

export const VDD = 3.3;
const V_HIGH = 0.7 * VDD;
const V_LOW = 0.3 * VDD;

interface DriveState {
  strong: number | null;
  weak: number | null;
}

export interface ProbeReading {
  /** Fraction of the window the net was high (0..1). */
  duty: number;
  /** Rising edges per second in the window. */
  freq: number;
  /** Duration of the most recent complete high pulse, in seconds (0 if none yet). */
  lastHighSec: number;
  /** Time between the two most recent rising edges, in seconds (0 if unknown). */
  lastPeriodSec: number;
  windowSec: number;
}

/** Measures duty cycle / frequency of a net over the interval between two read() calls. */
export class NetProbe {
  private windowStart: number;
  private highAcc = 0;
  private lastT: number;
  private rises = 0;
  /** Time of the most recent rising edge in seconds (-1 if none yet). */
  lastRise = -1;
  lastHighSec = 0;
  lastPeriodSec = 0;

  constructor(private net: Net) {
    this.windowStart = this.lastT = net.clock.seconds();
    net.probes.push(this);
  }

  /** Called by the net just before its level changes to `level`. */
  edge(t: number, level: number): void {
    if (level) {
      if (this.lastRise >= 0) this.lastPeriodSec = t - this.lastRise;
      this.lastRise = t;
      this.rises++;
    } else {
      this.highAcc += t - this.lastT;
      if (this.lastRise >= 0) this.lastHighSec = t - this.lastRise;
    }
    this.lastT = t;
  }

  read(): ProbeReading {
    const now = this.net.clock.seconds();
    if (this.net.level) this.highAcc += now - this.lastT;
    this.lastT = now;
    const windowSec = now - this.windowStart;
    const r: ProbeReading = {
      duty: windowSec > 0 ? Math.min(1, this.highAcc / windowSec) : this.net.level,
      freq: windowSec > 0 ? this.rises / windowSec : 0,
      lastHighSec: this.lastHighSec,
      lastPeriodSec: this.lastPeriodSec,
      windowSec,
    };
    this.windowStart = now;
    this.highAcc = 0;
    this.rises = 0;
    return r;
  }
}

export class Net {
  /** Resolved voltage. */
  v = 0;
  /** Digital level seen by a Schmitt-trigger input (keeps its value between the thresholds). */
  level = 0;
  /** True if nothing drives or pulls the net. */
  floating = true;
  /** True if two strong drivers disagree (a short circuit). */
  contention = false;
  /** True if at least one strong driver (output, switch, source) is active. */
  driven = false;
  /** Set by devices that leave the net undriven at times (e.g. "button A"): enables the floating-input hint. */
  floatHint: string | null = null;
  /** Names of the board devices attached to this net. */
  readonly attached: string[] = [];
  readonly probes: NetProbe[] = [];

  /** Transition log (seconds, volts) when tracing is enabled. */
  tracing = false;
  traceT: number[] = [];
  traceV: number[] = [];

  private drivers = new Map<object, DriveState>();
  private listeners: Array<(net: Net) => void> = [];

  constructor(
    readonly name: string,
    readonly clock: Clock,
  ) {}

  onChange(fn: (net: Net) => void): void {
    this.listeners.push(fn);
  }

  /** Set this owner's contribution: a strong drive voltage and/or a weak pull voltage (null = none). */
  drive(owner: object, strong: number | null, weak: number | null = null): void {
    const cur = this.drivers.get(owner);
    if (cur) {
      if (cur.strong === strong && cur.weak === weak) return;
      cur.strong = strong;
      cur.weak = weak;
    } else {
      if (strong === null && weak === null) return;
      this.drivers.set(owner, { strong, weak });
    }
    this.resolve();
  }

  startTrace(): void {
    this.tracing = true;
    this.traceT = [this.clock.seconds()];
    this.traceV = [this.v];
  }

  private resolve(): void {
    let sSum = 0;
    let sCount = 0;
    let sMin = Infinity;
    let sMax = -Infinity;
    let wSum = 0;
    let wCount = 0;
    for (const d of this.drivers.values()) {
      if (d.strong !== null) {
        sSum += d.strong;
        sCount++;
        if (d.strong < sMin) sMin = d.strong;
        if (d.strong > sMax) sMax = d.strong;
      }
      if (d.weak !== null) {
        wSum += d.weak;
        wCount++;
      }
    }
    let v = this.v;
    this.floating = sCount === 0 && wCount === 0;
    this.contention = sCount > 1 && sMax - sMin > 1;
    this.driven = sCount > 0;
    if (sCount > 0) v = sSum / sCount;
    else if (wCount > 0) v = wSum / wCount;
    if (v === this.v) return;

    let level = this.level;
    if (v >= V_HIGH) level = 1;
    else if (v <= V_LOW) level = 0;
    if (level !== this.level) {
      const t = this.clock.seconds();
      for (const p of this.probes) p.edge(t, level);
    }
    this.v = v;
    this.level = level;
    if (this.tracing) {
      if (this.traceT.length > 400_000) {
        this.traceT = this.traceT.slice(200_000);
        this.traceV = this.traceV.slice(200_000);
      }
      this.traceT.push(this.clock.seconds());
      this.traceV.push(v);
    }
    for (const fn of this.listeners) fn(this);
  }
}
