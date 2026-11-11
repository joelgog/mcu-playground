/** GPIO ports and the alternate-function multiplexer that connects pins to timers and the USART. */
import { Net, VDD } from '../../board/net';
import { HintFn, Peripheral } from '../bus';

/** pin name -> alternate function number -> signal name (subset of the STM32F072 datasheet table). */
export const AF_TABLE: Record<string, Record<number, string>> = {
  PA0: { 2: 'TIM2_CH1' },
  PA1: { 2: 'TIM2_CH2' },
  PA2: { 1: 'USART2_TX', 2: 'TIM2_CH3' },
  PA3: { 1: 'USART2_RX', 2: 'TIM2_CH4' },
  PA4: { 4: 'TIM14_CH1' },
  PA5: { 2: 'TIM2_CH1' },
  PA6: { 1: 'TIM3_CH1' },
  PA7: { 1: 'TIM3_CH2', 4: 'TIM14_CH1' },
  PA14: { 1: 'USART2_TX' },
  PA15: { 1: 'USART2_RX', 2: 'TIM2_CH1' },
  PB0: { 1: 'TIM3_CH3' },
  PB1: { 0: 'TIM14_CH1', 1: 'TIM3_CH4' },
  PB3: { 2: 'TIM2_CH2' },
  PB4: { 1: 'TIM3_CH1' },
  PB5: { 1: 'TIM3_CH2' },
  PB10: { 2: 'TIM2_CH3' },
  PB11: { 2: 'TIM2_CH4' },
  PC6: { 0: 'TIM3_CH1' },
  PC7: { 0: 'TIM3_CH2' },
  PC8: { 0: 'TIM3_CH3' },
  PC9: { 0: 'TIM3_CH4' },
};

export class AfMux {
  private outputs = new Map<string, number | null>();
  private inputs = new Map<string, (level: number) => void>();
  private candidates = new Map<string, Array<{ port: GpioPort; pin: number; af: number }>>();

  register(port: GpioPort): void {
    for (let pin = 0; pin < 16; pin++) {
      const afs = AF_TABLE[`P${port.letter}${pin}`];
      if (!afs) continue;
      for (const [af, signal] of Object.entries(afs)) {
        let list = this.candidates.get(signal);
        if (!list) this.candidates.set(signal, (list = []));
        list.push({ port, pin, af: Number(af) });
      }
    }
  }

  signalFor(letter: string, pin: number, af: number): string | undefined {
    return AF_TABLE[`P${letter}${pin}`]?.[af];
  }

  /** A peripheral drives one of its output signals (null = not driving). */
  setOutput(signal: string, level: number | null): void {
    if (this.outputs.get(signal) === level) return;
    this.outputs.set(signal, level);
    const list = this.candidates.get(signal);
    if (list) for (const c of list) c.port.refreshPin(c.pin);
  }

  outputLevel(signal: string): number | null {
    return this.outputs.get(signal) ?? null;
  }

  onInput(signal: string, fn: (level: number) => void): void {
    this.inputs.set(signal, fn);
  }

  input(signal: string, level: number): void {
    this.inputs.get(signal)?.(level);
  }

  /** Pins currently switched to this signal (alternate-function mode with the matching AF number). */
  routedPins(signal: string): string[] {
    const out: string[] = [];
    for (const c of this.candidates.get(signal) ?? []) {
      if (c.port.mode(c.pin) === 2 && c.port.af(c.pin) === c.af) out.push(`P${c.port.letter}${c.pin}`);
    }
    return out;
  }

  /** All pins that could carry this signal, e.g. "PA2 (AF1)". */
  describeOptions(signal: string): string {
    return (this.candidates.get(signal) ?? []).map((c) => `P${c.port.letter}${c.pin} (AF${c.af})`).join(' or ');
  }

  /** Current level of the first pin routed to an input signal. */
  inputLevel(signal: string): number | null {
    for (const c of this.candidates.get(signal) ?? []) {
      if (c.port.mode(c.pin) === 2 && c.port.af(c.pin) === c.af) return c.port.nets[c.pin].level;
    }
    return null;
  }

  reset(): void {
    this.outputs.clear();
  }
}

export interface ExtiSink {
  pinChanged(portIndex: number, pin: number, level: number): void;
}

export class GpioPort implements Peripheral {
  readonly name: string;
  moder = 0;
  otyper = 0;
  ospeedr = 0;
  pupdr = 0;
  odr = 0;
  afrl = 0;
  afrh = 0;
  lckr = 0;
  private readonly owners: object[] = [];
  private lastLevel = new Uint8Array(16);

  constructor(
    readonly letter: string,
    readonly index: number,
    readonly nets: Net[],
    private afmux: AfMux,
    private exti: ExtiSink,
    private hint: HintFn,
  ) {
    this.name = `GPIO${letter}`;
    for (let i = 0; i < 16; i++) {
      this.owners.push({ pin: `P${letter}${i}` });
      nets[i].onChange(() => this.netChanged(i));
    }
    afmux.register(this);
  }

  mode(pin: number): number {
    return (this.moder >>> (pin * 2)) & 3;
  }

  af(pin: number): number {
    return pin < 8 ? (this.afrl >>> (pin * 4)) & 15 : (this.afrh >>> ((pin - 8) * 4)) & 15;
  }

  pull(pin: number): number {
    return (this.pupdr >>> (pin * 2)) & 3;
  }

  reset(): void {
    // PA13/PA14 are the debug pins (SWDIO/SWCLK) after reset.
    this.moder = this.index === 0 ? 0x28000000 : 0;
    this.pupdr = this.index === 0 ? 0x24000000 : 0;
    this.ospeedr = this.index === 0 ? 0x0c000000 : 0;
    this.otyper = 0;
    this.odr = 0;
    this.afrl = 0;
    this.afrh = 0;
    this.lckr = 0;
    for (let i = 0; i < 16; i++) {
      this.refreshPin(i);
      this.lastLevel[i] = this.nets[i].level;
    }
  }

  /** Recompute what this pin drives onto its net. */
  refreshPin(pin: number): void {
    const mode = this.mode(pin);
    const pull = this.pull(pin);
    let weak: number | null = pull === 1 ? VDD : pull === 2 ? 0 : null;
    let out: number | null = null;
    if (mode === 1) out = (this.odr >>> pin) & 1;
    else if (mode === 2) {
      const signal = this.afmux.signalFor(this.letter, pin, this.af(pin));
      out = signal ? this.afmux.outputLevel(signal) : null;
    } else if (mode === 3) weak = null;
    let strong: number | null = null;
    if (out !== null) {
      if ((this.otyper >>> pin) & 1) strong = out ? null : 0; // open drain: only pulls low
      else strong = out ? VDD : 0;
    }
    this.nets[pin].drive(this.owners[pin], strong, weak);
  }

  private refreshAll(): void {
    for (let i = 0; i < 16; i++) this.refreshPin(i);
  }

  private netChanged(pin: number): void {
    const level = this.nets[pin].level;
    if (level === this.lastLevel[pin]) return;
    this.lastLevel[pin] = level;
    const mode = this.mode(pin);
    if (mode === 3) return; // analog mode: digital input path is switched off
    this.exti.pinChanged(this.index, pin, level);
    if (mode === 2) {
      const signal = this.afmux.signalFor(this.letter, pin, this.af(pin));
      if (signal) this.afmux.input(signal, level);
    }
  }

  private idr(): number {
    let v = 0;
    for (let i = 0; i < 16; i++) {
      const net = this.nets[i];
      const mode = this.mode(i);
      if (mode === 3) continue;
      if (net.level) v |= 1 << i;
      if (mode === 0 && net.floating && net.floatHint) {
        this.hint(
          `float:${net.name}`,
          `${net.name} is read as an input, but nothing defines its level while ${net.floatHint} is open (the pin floats). ` +
            `Enable the internal pull-up or pull-down in GPIO${this.letter}->PUPDR.`,
        );
      }
    }
    return v;
  }

  read32(off: number): number {
    switch (off) {
      case 0x00: return this.moder;
      case 0x04: return this.otyper;
      case 0x08: return this.ospeedr;
      case 0x0c: return this.pupdr;
      case 0x10: return this.idr();
      case 0x14: return this.odr;
      case 0x1c: return this.lckr;
      case 0x20: return this.afrl;
      case 0x24: return this.afrh;
      default: return 0;
    }
  }

  peek32(off: number): number {
    if (off === 0x10) {
      let v = 0;
      for (let i = 0; i < 16; i++) if (this.mode(i) !== 3 && this.nets[i].level) v |= 1 << i;
      return v;
    }
    return this.read32(off);
  }

  write32(off: number, v: number): void {
    switch (off) {
      case 0x00: this.moder = v; this.refreshAll(); break;
      case 0x04: this.otyper = v & 0xffff; this.refreshAll(); break;
      case 0x08: this.ospeedr = v; break;
      case 0x0c: this.pupdr = v; this.refreshAll(); break;
      case 0x14: this.setOdr(v & 0xffff); break;
      case 0x18: this.setOdr((this.odr | (v & 0xffff)) & ~(v >>> 16)); break; // BSRR: set wins over reset
      case 0x1c: this.lckr = v & 0x1ffff; break;
      case 0x20: this.afrl = v; this.refreshAll(); break;
      case 0x24: this.afrh = v; this.refreshAll(); break;
      case 0x28: this.setOdr(this.odr & ~(v & 0xffff)); break; // BRR
    }
  }

  private setOdr(v: number): void {
    const changed = (this.odr ^ v) & 0xffff;
    this.odr = v & 0xffff;
    if (!changed) return;
    for (let i = 0; i < 16; i++) {
      if (changed & (1 << i)) {
        if (this.mode(i) === 1) this.refreshPin(i);
        else if (this.nets[i].attached.length > 0 && this.mode(i) === 0) {
          // Writing the level before switching to output is fine; only complain if it stays an input.
          const net = this.nets[i];
          net.clock.scheduleSec(0.002, () => {
            if (this.mode(i) !== 0) return;
            this.hint(
              `odr-input:${net.name}`,
              `${net.name} was written through ODR/BSRR, but the pin is still configured as an input, so nothing happens on the pin. ` +
                `Set its MODER bits to 01 (output).`,
            );
          });
        }
      }
    }
  }

  /** Human-readable description of a pin's configuration, for the UI. */
  describe(pin: number): string {
    const mode = this.mode(pin);
    const pull = ['no pull', 'pull-up', 'pull-down', 'reserved'][this.pull(pin)];
    if (mode === 0) return `input, ${pull}`;
    if (mode === 3) return 'analog';
    const type = (this.otyper >>> pin) & 1 ? 'open-drain' : 'push-pull';
    if (mode === 1) return `output, ${type}, ${pull}`;
    const signal = this.afmux.signalFor(this.letter, pin, this.af(pin));
    return `alternate function AF${this.af(pin)}${signal ? ` (${signal})` : ' (nothing connected)'}, ${type}`;
  }
}
