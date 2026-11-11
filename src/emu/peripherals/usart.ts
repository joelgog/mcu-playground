/** USART (asynchronous mode): transmitter with real bit timing on the TX pin, receiver with overrun detection. */
import { HintFn, Peripheral } from '../bus';
import { Clock, SimEvent } from '../clock';
import { AfMux } from './gpio';

const ISR_FE = 0x02;
const ISR_ORE = 0x08;
const ISR_IDLE = 0x10;
const ISR_RXNE = 0x20;
const ISR_TC = 0x40;
const ISR_TXE = 0x80;

export interface UsartEnv {
  clock: Clock;
  afmux: AfMux;
  setIrq: (level: boolean) => void;
  pclkHz: () => number;
  /** HCLK cycles per PCLK cycle. */
  pclkDiv: () => number;
  hint: HintFn;
}

export class Usart implements Peripheral {
  cr1 = 0;
  cr2 = 0;
  cr3 = 0;
  brr = 0;
  isr = ISR_TC | ISR_TXE;
  rdr = 0;
  tdr = 0;
  /** A complete byte left the TX pin. */
  onTx: (byte: number, baud: number) => void = () => {};

  private txBusy = false;
  private tdrFull = false;
  private txEvent: SimEvent | null = null;
  private rxQueue: Array<{ byte: number; baud: number }> = [];
  private rxEvent: SimEvent | null = null;
  private readonly txSignal: string;
  private readonly rxSignal: string;

  constructor(
    readonly name: string,
    private env: UsartEnv,
  ) {
    this.txSignal = `${name}_TX`;
    this.rxSignal = `${name}_RX`;
  }

  reset(): void {
    this.env.clock.cancel(this.txEvent);
    this.env.clock.cancel(this.rxEvent);
    this.txEvent = this.rxEvent = null;
    this.cr1 = this.cr2 = this.cr3 = this.brr = this.rdr = this.tdr = 0;
    this.isr = ISR_TC | ISR_TXE;
    this.txBusy = this.tdrFull = false;
    this.rxQueue = [];
    this.env.afmux.setOutput(this.txSignal, null);
    this.env.setIrq(false);
  }

  /** Configured baud rate (0 if BRR is not set). */
  baud(): number {
    if (this.brr === 0) return 0;
    if (this.cr1 & 0x8000) {
      const div = (this.brr & 0xfff0) | ((this.brr & 7) << 1);
      return div ? (2 * this.env.pclkHz()) / div : 0;
    }
    return this.env.pclkHz() / this.brr;
  }

  private enabledTx(): boolean {
    return (this.cr1 & 0x9) === 0x9;
  }

  private startTx(byte: number): void {
    const clock = this.env.clock;
    this.txBusy = true;
    this.isr &= ~ISR_TC;
    const dataBits = this.cr1 & 0x1000 ? 9 : 8;
    const levels: number[] = [0];
    let ones = 0;
    const parity = (this.cr1 & 0x400) !== 0;
    const payloadBits = parity ? dataBits - 1 : dataBits;
    for (let i = 0; i < payloadBits; i++) {
      const b = (byte >> i) & 1;
      ones += b;
      levels.push(b);
    }
    if (parity) levels.push(this.cr1 & 0x200 ? (ones + 1) & 1 : ones & 1);
    levels.push(1);
    if (((this.cr2 >>> 12) & 3) === 2) levels.push(1);
    const baud = this.baud();
    const bitCycles = baud > 0 ? clock.hz / baud : this.env.pclkDiv() * 16;
    const start = clock.time();
    let k = 0;
    const stepBit = (): void => {
      this.env.afmux.setOutput(this.txSignal, levels[k]);
      // jump to the next bit boundary at which the line level changes
      let n = k + 1;
      while (n < levels.length && levels[n] === levels[k]) n++;
      k = n;
      if (n < levels.length) this.txEvent = clock.schedule(start + n * bitCycles, stepBit);
      else this.txEvent = clock.schedule(start + levels.length * bitCycles, () => this.txDone(byte, baud));
    };
    stepBit();
  }

  private txDone(byte: number, baud: number): void {
    this.txEvent = null;
    const mask = this.cr1 & 0x1000 ? 0x1ff : this.cr1 & 0x400 ? 0x7f : 0xff;
    if (this.env.afmux.routedPins(this.txSignal).length > 0) {
      this.onTx(byte & mask, baud);
    } else {
      this.env.hint(
        `${this.name}:txpin`,
        `${this.name} is transmitting, but no pin is switched to its TX function, so nothing leaves the chip. ` +
          `Put ${this.env.afmux.describeOptions(this.txSignal)} into alternate-function mode.`,
      );
    }
    if (this.tdrFull && this.enabledTx()) {
      this.tdrFull = false;
      this.isr |= ISR_TXE;
      this.startTx(this.tdr);
    } else {
      this.txBusy = false;
      this.isr |= ISR_TC;
    }
    this.updateIrq();
  }

  /** A byte arrives from the outside world at the given baud rate. */
  receive(byte: number, baud: number): void {
    this.rxQueue.push({ byte, baud });
    if (!this.rxEvent) this.nextRx();
  }

  private nextRx(): void {
    const item = this.rxQueue.shift();
    if (!item) {
      this.rxEvent = null;
      return;
    }
    this.rxEvent = this.env.clock.scheduleSec(10 / item.baud, () => {
      this.deliver(item.byte, item.baud);
      this.nextRx();
    });
  }

  private deliver(byte: number, baud: number): void {
    if ((this.cr1 & 0x5) !== 0x5) {
      this.env.hint(`${this.name}:rxoff`, `A byte arrived at ${this.name}, but its receiver is not enabled (CR1 UE and RE).`);
      return;
    }
    if (this.env.afmux.routedPins(this.rxSignal).length === 0) {
      this.env.hint(
        `${this.name}:rxpin`,
        `A byte arrived for ${this.name}, but no pin is switched to its RX function. ` +
          `Put ${this.env.afmux.describeOptions(this.rxSignal)} into alternate-function mode.`,
      );
      return;
    }
    const mine = this.baud();
    if (mine <= 0 || Math.abs(mine - baud) / baud > 0.04) {
      this.isr |= ISR_FE;
      byte = (byte * 37 + 0x55) & 0xff;
      this.env.hint(
        `${this.name}:rxbaud`,
        `${this.name} received data at ${baud} baud but is configured for ${Math.round(mine)} baud, so it sees framing errors and garbage.`,
      );
    }
    if (this.isr & ISR_RXNE) {
      this.isr |= ISR_ORE;
      this.env.hint(
        `${this.name}:ore`,
        `${this.name} overrun: a new byte arrived before the previous one was read from RDR, so it was lost. ` +
          `Read RDR faster (interrupt + ring buffer) and clear ORE via ICR.`,
      );
    } else {
      this.rdr = byte;
      this.isr |= ISR_RXNE;
    }
    this.updateIrq();
  }

  private updateIrq(): void {
    const isr = this.isr;
    const cr1 = this.cr1;
    const level =
      (cr1 & 0x20 && isr & (ISR_RXNE | ISR_ORE)) ||
      (cr1 & 0x40 && isr & ISR_TC) ||
      (cr1 & 0x80 && isr & ISR_TXE) ||
      (cr1 & 0x10 && isr & ISR_IDLE);
    this.env.setIrq((cr1 & 1) !== 0 && !!level);
  }

  read32(off: number): number {
    switch (off) {
      case 0x00: return this.cr1;
      case 0x04: return this.cr2;
      case 0x08: return this.cr3;
      case 0x0c: return this.brr;
      case 0x1c: {
        let v = this.isr;
        if (this.cr1 & 1) v |= (this.cr1 & 8 ? 1 << 21 : 0) | (this.cr1 & 4 ? 1 << 22 : 0);
        return v;
      }
      case 0x24: {
        const v = this.rdr;
        this.isr &= ~ISR_RXNE;
        this.updateIrq();
        return v;
      }
      case 0x28: return this.tdr;
      default: return 0;
    }
  }

  peek32(off: number): number {
    if (off === 0x24) return this.rdr;
    return this.read32(off);
  }

  write32(off: number, value: number): void {
    const v = value >>> 0;
    switch (off) {
      case 0x00: {
        this.cr1 = v;
        if (this.enabledTx()) {
          if (!this.txBusy) this.env.afmux.setOutput(this.txSignal, 1); // idle line is high
        } else {
          this.env.clock.cancel(this.txEvent);
          this.txEvent = null;
          this.txBusy = false;
          this.tdrFull = false;
          this.isr |= ISR_TXE | ISR_TC;
          this.env.afmux.setOutput(this.txSignal, null);
        }
        break;
      }
      case 0x04: this.cr2 = v; break;
      case 0x08: this.cr3 = v; break;
      case 0x0c: this.brr = v & 0xffff; break;
      case 0x18: // RQR
        if (v & 8) this.isr &= ~ISR_RXNE;
        break;
      case 0x20: // ICR: write 1 to clear
        this.isr &= ~(v & (0x01 | ISR_FE | 0x04 | ISR_ORE | ISR_IDLE | ISR_TC));
        break;
      case 0x28:
        this.tdr = v & 0x1ff;
        if (!this.enabledTx()) {
          this.env.hint(`${this.name}:txoff`, `${this.name}->TDR was written, but the transmitter is not enabled (CR1 UE and TE), so nothing is sent.`);
        } else if (this.brr === 0) {
          this.env.hint(`${this.name}:brr`, `${this.name}->BRR is 0, so the baud rate is undefined. Set BRR = clock / baud.`);
        } else if (!this.txBusy) {
          this.startTx(this.tdr);
        } else {
          if (this.tdrFull) {
            this.env.hint(
              `${this.name}:txoverwrite`,
              `${this.name}->TDR was written while TXE was 0, overwriting a byte that had not been sent yet. Wait for the TXE flag before each write.`,
            );
          }
          this.tdrFull = true;
          this.isr &= ~ISR_TXE;
        }
        break;
    }
    this.updateIrq();
  }
}
