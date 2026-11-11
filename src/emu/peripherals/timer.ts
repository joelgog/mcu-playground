/**
 * General-purpose / basic timer (TIM2, TIM3, TIM14, TIM6, TIM7).
 *
 * Up-counting only. The counter is not stepped every cycle: its value is derived
 * from the elapsed time, and events are scheduled for the next overflow or
 * compare match, so timing is exact and fast.
 *
 * Modelled: PSC/ARR with preload semantics (PSC only takes effect at an update
 * event), update interrupt, one-pulse mode, output compare and PWM mode 1/2 on
 * the alternate-function pins, input capture, and slave reset mode (PWM input).
 */
import { HintFn, Peripheral } from '../bus';
import { Clock, SimEvent } from '../clock';
import { AfMux } from './gpio';

export interface TimerEnv {
  clock: Clock;
  afmux: AfMux;
  setIrq: (level: boolean) => void;
  /** HCLK cycles per timer clock tick. */
  clkDiv: () => number;
  hint: HintFn;
}

export class Timer implements Peripheral {
  cr1 = 0;
  cr2 = 0;
  smcr = 0;
  dier = 0;
  sr = 0;
  ccmr1 = 0;
  ccmr2 = 0;
  ccer = 0;
  psc = 0;
  arr: number;
  readonly ccr = [0, 0, 0, 0];

  private pscA = 0;
  private arrA: number;
  private readonly ccrA = [0, 0, 0, 0];
  private readonly ref = [0, 0, 0, 0];
  private running = false;
  private cnt0 = 0;
  private t0 = 0;
  private tp = 1;
  private ev: SimEvent | null = null;
  private readonly max: number;

  constructor(
    readonly name: string,
    bits: 16 | 32,
    private nch: number,
    private env: TimerEnv,
  ) {
    this.max = bits === 32 ? 0xffffffff : 0xffff;
    this.arr = this.arrA = this.max;
    for (let i = 0; i < nch; i++) {
      env.afmux.onInput(`${name}_CH${i + 1}`, (level) => this.tiEdge(i, level));
    }
  }

  reset(): void {
    this.env.clock.cancel(this.ev);
    this.ev = null;
    this.cr1 = this.cr2 = this.smcr = this.dier = this.sr = 0;
    this.ccmr1 = this.ccmr2 = this.ccer = 0;
    this.psc = this.pscA = 0;
    this.arr = this.arrA = this.max;
    for (let i = 0; i < 4; i++) this.ccr[i] = this.ccrA[i] = this.ref[i] = 0;
    this.running = false;
    this.cnt0 = 0;
    this.tp = this.env.clkDiv();
    this.refreshOutputs();
    this.env.setIrq(false);
  }

  /** Called when the RCC prescalers change. */
  clockChanged(): void {
    this.sync(this.env.clock.time());
    this.tp = (this.pscA + 1) * this.env.clkDiv();
    this.schedule();
  }

  /** Effective counting frequency information for the UI. */
  describe(hclkHz: number): string {
    const tick = hclkHz / this.env.clkDiv() / (this.pscA + 1);
    const period = tick / (this.arrA + 1);
    return `${this.name}: ${this.running ? 'running' : 'stopped'}, tick ${fmtHz(tick)}, overflow ${fmtHz(period)} (PSC=${this.pscA}, ARR=${this.arrA})`;
  }

  // ------------------------------------------------------------ counting

  private sync(now: number): void {
    if (!this.running) return;
    const ticks = Math.floor((now - this.t0) / this.tp);
    if (ticks > 0) {
      this.cnt0 += ticks;
      this.t0 += ticks * this.tp;
    }
  }

  private ccSel(i: number): number {
    return ((i < 2 ? this.ccmr1 : this.ccmr2) >>> ((i & 1) * 8)) & 3;
  }

  private ocMode(i: number): number {
    return ((i < 2 ? this.ccmr1 : this.ccmr2) >>> ((i & 1) * 8 + 4)) & 7;
  }

  private ocPreload(i: number): boolean {
    return (((i < 2 ? this.ccmr1 : this.ccmr2) >>> ((i & 1) * 8 + 3)) & 1) === 1;
  }

  private schedule(): void {
    const clock = this.env.clock;
    clock.cancel(this.ev);
    this.ev = null;
    if (!this.running || this.arrA === 0) return;
    const cnt = this.cnt0;
    let ticks = cnt <= this.arrA ? this.arrA - cnt + 1 : this.max - cnt + 1;
    for (let i = 0; i < this.nch; i++) {
      if (this.ccSel(i) !== 0) continue;
      const c = this.ccrA[i];
      if (c > cnt && c - cnt < ticks) ticks = c - cnt;
    }
    this.ev = clock.schedule(this.t0 + ticks * this.tp, this.fire);
  }

  private fire = (at: number): void => {
    const prev = this.cnt0;
    this.sync(at);
    if ((prev <= this.arrA && this.cnt0 > this.arrA) || this.cnt0 > this.max) {
      this.cnt0 = 0;
      this.updateEvent(false);
    }
    for (let i = 0; i < this.nch; i++) {
      if (this.ccSel(i) === 0 && this.ccrA[i] === this.cnt0) this.match(i);
    }
    this.refreshOutputs();
    this.schedule();
    this.updateIrq();
  };

  private updateEvent(fromSoftware: boolean): void {
    if (this.cr1 & 2) return; // UDIS
    this.pscA = this.psc;
    this.tp = (this.pscA + 1) * this.env.clkDiv();
    this.arrA = this.arr;
    for (let i = 0; i < 4; i++) this.ccrA[i] = this.ccr[i];
    if (!(fromSoftware && this.cr1 & 4)) this.sr |= 1;
    if (this.cr1 & 8) {
      // one-pulse mode: stop at the update event
      this.cr1 &= ~1;
      this.running = false;
    }
  }

  private match(i: number): void {
    this.sr |= 2 << i;
    switch (this.ocMode(i)) {
      case 1: this.ref[i] = 1; break;
      case 2: this.ref[i] = 0; break;
      case 3: this.ref[i] ^= 1; break;
    }
  }

  private refreshOutputs(): void {
    for (let i = 0; i < this.nch; i++) {
      const signal = `${this.name}_CH${i + 1}`;
      if (this.ccSel(i) !== 0) {
        this.env.afmux.setOutput(signal, null);
        continue;
      }
      switch (this.ocMode(i)) {
        case 4: this.ref[i] = 0; break;
        case 5: this.ref[i] = 1; break;
        case 6: this.ref[i] = this.cnt0 < this.ccrA[i] ? 1 : 0; break;
        case 7: this.ref[i] = this.cnt0 < this.ccrA[i] ? 0 : 1; break;
      }
      const enabled = (this.ccer >>> (i * 4)) & 1;
      const inverted = (this.ccer >>> (i * 4 + 1)) & 1;
      this.env.afmux.setOutput(signal, enabled ? this.ref[i] ^ inverted : null);
    }
  }

  private updateIrq(): void {
    this.env.setIrq((this.sr & this.dier & 0x5f) !== 0);
  }

  // -------------------------------------------------------- input capture

  private edgeMatches(i: number, level: number): boolean {
    const p = (this.ccer >>> (i * 4 + 1)) & 1;
    const np = (this.ccer >>> (i * 4 + 3)) & 1;
    if (p && np) return true;
    return p ? level === 0 : level === 1;
  }

  /** An edge arrived on timer input TI(ti+1). */
  private tiEdge(ti: number, level: number): void {
    const now = this.env.clock.time();
    this.sync(now);
    for (let i = 0; i < this.nch; i++) {
      const sel = this.ccSel(i);
      if (sel === 0 || sel === 3) continue;
      const source = sel === 1 ? i : i ^ 1;
      if (source !== ti) continue;
      if (!((this.ccer >>> (i * 4)) & 1)) continue;
      if (!this.edgeMatches(i, level)) continue;
      this.ccr[i] = this.ccrA[i] = this.cnt0;
      if (this.sr & (2 << i)) this.sr |= 0x200 << i; // overcapture
      this.sr |= 2 << i;
    }
    // Slave reset mode: the selected input edge restarts the counter (used for PWM input measurement).
    if ((this.smcr & 7) === 4) {
      const ts = (this.smcr >>> 4) & 7;
      const trigger = ts === 5 ? 0 : ts === 6 ? 1 : -1;
      if (trigger === ti && this.edgeMatches(ti, level)) {
        this.cnt0 = 0;
        this.t0 = now;
        this.updateEvent(false);
        this.sr |= 0x40;
        this.refreshOutputs();
        this.schedule();
      }
    }
    this.updateIrq();
  }

  // ------------------------------------------------------------ registers

  read32(off: number): number {
    switch (off) {
      case 0x00: return this.cr1;
      case 0x04: return this.cr2;
      case 0x08: return this.smcr;
      case 0x0c: return this.dier;
      case 0x10: return this.sr;
      case 0x18: return this.ccmr1;
      case 0x1c: return this.ccmr2;
      case 0x20: return this.ccer;
      case 0x24:
        this.sync(this.env.clock.time());
        return this.cnt0;
      case 0x28: return this.psc;
      case 0x2c: return this.arr;
      case 0x34:
      case 0x38:
      case 0x3c:
      case 0x40: {
        const i = (off - 0x34) >> 2;
        if (this.ccSel(i) !== 0 && this.sr & (2 << i)) {
          this.sr &= ~(2 << i);
          this.updateIrq();
        }
        return this.ccr[i];
      }
      default: return 0;
    }
  }

  peek32(off: number): number {
    if (off >= 0x34 && off <= 0x40) return this.ccr[(off - 0x34) >> 2];
    return this.read32(off);
  }

  write32(off: number, value: number): void {
    const v = value >>> 0;
    const now = this.env.clock.time();
    switch (off) {
      case 0x00: {
        this.sync(now);
        const was = this.cr1 & 1;
        this.cr1 = v & 0x3ff;
        if (this.cr1 & 0x70) {
          this.env.hint(`${this.name}:dir`, `${this.name}: down-counting and centre-aligned modes are not simulated; the timer counts up.`);
        }
        if (this.cr1 & 1 && !was) {
          this.running = true;
          this.t0 = now;
        } else if (!(this.cr1 & 1) && was) {
          this.running = false;
        }
        this.schedule();
        break;
      }
      case 0x04: this.cr2 = v; break;
      case 0x08:
        this.smcr = v & 0xffff;
        if ((v & 7) !== 0 && (v & 7) !== 4) {
          this.env.hint(`${this.name}:smcr`, `${this.name}: only slave reset mode (SMS = 100) is simulated; other slave/encoder modes are ignored.`);
        }
        break;
      case 0x0c: this.dier = v & 0x5f5f; break;
      case 0x10: this.sr &= v; break; // flags are cleared by writing 0
      case 0x14:
        if (v & 1) {
          this.sync(now);
          this.cnt0 = 0;
          this.t0 = now;
          this.updateEvent(true);
          this.refreshOutputs();
          this.schedule();
        }
        this.sr |= v & 0x1e;
        break;
      case 0x18:
      case 0x1c:
        this.sync(now);
        if (off === 0x18) this.ccmr1 = v & 0xffff;
        else this.ccmr2 = v & 0xffff;
        this.refreshOutputs();
        this.schedule();
        break;
      case 0x20:
        this.sync(now);
        this.ccer = v & 0xffff;
        this.refreshOutputs();
        this.schedule();
        break;
      case 0x24:
        this.sync(now);
        this.cnt0 = v & this.max;
        this.t0 = now;
        this.refreshOutputs();
        this.schedule();
        break;
      case 0x28: this.psc = v & 0xffff; break;
      case 0x2c:
        this.arr = v & this.max;
        if (!(this.cr1 & 0x80)) {
          this.sync(now);
          this.arrA = this.arr;
          this.schedule();
        }
        break;
      case 0x34:
      case 0x38:
      case 0x3c:
      case 0x40: {
        const i = (off - 0x34) >> 2;
        this.ccr[i] = v & this.max;
        if (!this.ocPreload(i)) {
          this.sync(now);
          this.ccrA[i] = this.ccr[i];
          this.refreshOutputs();
          this.schedule();
        }
        break;
      }
    }
    this.updateIrq();
  }
}

function fmtHz(hz: number): string {
  if (hz >= 1e6) return `${+(hz / 1e6).toPrecision(4)} MHz`;
  if (hz >= 1e3) return `${+(hz / 1e3).toPrecision(4)} kHz`;
  return `${+hz.toPrecision(4)} Hz`;
}
