/** EXTI (external interrupt controller) and the SYSCFG port multiplexer in front of it. */
import { Peripheral } from '../bus';
import { ExtiSink } from './gpio';

export class Syscfg implements Peripheral {
  readonly name = 'SYSCFG';
  cfgr1 = 0;
  exticr = [0, 0, 0, 0];

  reset(): void {
    this.cfgr1 = 0;
    this.exticr = [0, 0, 0, 0];
  }

  /** Index of the GPIO port (0 = A) routed to EXTI line n. */
  portForLine(line: number): number {
    return (this.exticr[line >> 2] >>> ((line & 3) * 4)) & 15;
  }

  read32(off: number): number {
    if (off === 0) return this.cfgr1;
    if (off >= 0x08 && off <= 0x14) return this.exticr[(off - 0x08) >> 2];
    return 0;
  }

  write32(off: number, v: number): void {
    if (off === 0) this.cfgr1 = v;
    else if (off >= 0x08 && off <= 0x14) this.exticr[(off - 0x08) >> 2] = v & 0xffff;
  }
}

export class Exti implements Peripheral, ExtiSink {
  readonly name = 'EXTI';
  imr = 0;
  emr = 0;
  rtsr = 0;
  ftsr = 0;
  swier = 0;
  pr = 0;

  constructor(
    private syscfg: Syscfg,
    private setIrq: (irq: number, level: boolean) => void,
  ) {}

  reset(): void {
    this.imr = 0x7f840000;
    this.emr = 0;
    this.rtsr = 0;
    this.ftsr = 0;
    this.swier = 0;
    this.pr = 0;
    this.updateIrq();
  }

  pinChanged(portIndex: number, pin: number, level: number): void {
    if (this.syscfg.portForLine(pin) !== portIndex) return;
    const bit = 1 << pin;
    if ((level ? this.rtsr : this.ftsr) & bit & this.imr) {
      this.pr |= bit;
      this.updateIrq();
    }
  }

  private updateIrq(): void {
    const active = this.pr & this.imr;
    this.setIrq(5, (active & 0x0003) !== 0);
    this.setIrq(6, (active & 0x000c) !== 0);
    this.setIrq(7, (active & 0xfff0) !== 0);
  }

  read32(off: number): number {
    switch (off) {
      case 0x00: return this.imr;
      case 0x04: return this.emr;
      case 0x08: return this.rtsr;
      case 0x0c: return this.ftsr;
      case 0x10: return this.swier;
      case 0x14: return this.pr;
      default: return 0;
    }
  }

  write32(off: number, v: number): void {
    switch (off) {
      case 0x00: this.imr = v; break;
      case 0x04: this.emr = v; break;
      case 0x08: this.rtsr = v & 0xffff; break;
      case 0x0c: this.ftsr = v & 0xffff; break;
      case 0x10: {
        const rising = v & ~this.swier & 0xffff;
        this.swier = v & 0xffff;
        this.pr |= rising & this.imr;
        break;
      }
      case 0x14: // write 1 to clear
        this.pr &= ~v;
        this.swier &= ~v;
        break;
    }
    this.updateIrq();
  }

  /** PR must not be modified by read-modify-write helpers on byte access. */
  peek32(off: number): number {
    return off === 0x14 ? 0 : this.read32(off);
  }
}
