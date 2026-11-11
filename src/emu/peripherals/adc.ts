/** 12-bit successive-approximation ADC of the STM32F0 (single ADC, channel sequence via CHSELR). */
import { HintFn, Peripheral } from '../bus';
import { Clock, SimEvent } from '../clock';

const SAMPLE_CYCLES = [1.5, 7.5, 13.5, 28.5, 41.5, 55.5, 71.5, 239.5];

const ISR_ADRDY = 1;
const ISR_EOC = 4;
const ISR_EOSEQ = 8;
const ISR_OVR = 16;

export interface AdcEnv {
  clock: Clock;
  setIrq: (level: boolean) => void;
  /** Voltage on an external channel 0..15 (the environment may emit hints about pin mode). */
  channelVolts: (ch: number) => number;
  pclkHz: () => number;
  chipTempC: () => number;
  hint: HintFn;
}

export class Adc implements Peripheral {
  readonly name = 'ADC';
  isr = 0;
  ier = 0;
  cr = 0;
  cfgr1 = 0;
  cfgr2 = 0;
  smpr = 0;
  tr = 0x0fff0000;
  chselr = 0;
  dr = 0;
  ccr = 0;

  private sequence: number[] = [];
  private seqIndex = 0;
  private ev: SimEvent | null = null;
  private pending: SimEvent[] = [];

  constructor(private env: AdcEnv) {}

  reset(): void {
    this.env.clock.cancel(this.ev);
    for (const e of this.pending) this.env.clock.cancel(e);
    this.pending = [];
    this.ev = null;
    this.isr = this.ier = this.cr = this.cfgr1 = this.cfgr2 = this.smpr = this.chselr = this.dr = this.ccr = 0;
    this.tr = 0x0fff0000;
    this.env.setIrq(false);
  }

  private adcHz(): number {
    const mode = this.cfgr2 >>> 30;
    if (mode === 1) return this.env.pclkHz() / 2;
    if (mode === 2) return this.env.pclkHz() / 4;
    return 14_000_000; // dedicated HSI14 oscillator
  }

  private later(sec: number, fn: () => void): void {
    this.pending.push(this.env.clock.scheduleSec(sec, fn));
    if (this.pending.length > 8) this.pending = this.pending.filter((e) => !e.cancelled).slice(-8);
  }

  private startSequence(): void {
    this.sequence = [];
    for (let ch = 0; ch <= 18; ch++) if (this.chselr & (1 << ch)) this.sequence.push(ch);
    if (this.cfgr1 & 4) this.sequence.reverse(); // SCANDIR
    if (this.sequence.length === 0) {
      this.env.hint('adc:nochannel', 'ADSTART was set but no channel is selected in ADC1->CHSELR, so nothing is converted.');
      this.cr &= ~4;
      return;
    }
    if ((this.cfgr1 >>> 10) & 3) {
      this.env.hint('adc:exten', 'Hardware-triggered conversions (EXTEN) are not simulated; the conversion starts immediately instead.');
    }
    this.seqIndex = 0;
    this.scheduleConversion();
  }

  private scheduleConversion(): void {
    const bits = 12 - 2 * ((this.cfgr1 >>> 3) & 3);
    const cycles = SAMPLE_CYCLES[this.smpr & 7] + bits + 0.5;
    this.env.clock.cancel(this.ev);
    this.ev = this.env.clock.scheduleSec(cycles / this.adcHz(), this.finishConversion);
  }

  private convert(ch: number): number {
    let raw12: number;
    if (ch === 16) {
      // Internal temperature sensor, calibrated at 30 C (1776) and 110 C (1347).
      if (!(this.ccr & (1 << 23))) {
        this.env.hint('adc:tsen', 'Channel 16 (temperature sensor) was converted without enabling it (ADC->CCR TSEN).');
        raw12 = 0;
      } else raw12 = 1776 + ((this.env.chipTempC() - 30) * (1347 - 1776)) / 80;
    } else if (ch === 17) {
      if (!(this.ccr & (1 << 22))) {
        this.env.hint('adc:vrefen', 'Channel 17 (VREFINT) was converted without enabling it (ADC->CCR VREFEN).');
        raw12 = 0;
      } else raw12 = 1526;
    } else if (ch === 18) {
      raw12 = 2048;
    } else {
      raw12 = (this.env.channelVolts(ch) / 3.3) * 4095;
    }
    raw12 = Math.max(0, Math.min(4095, Math.round(raw12)));
    const res = (this.cfgr1 >>> 3) & 3;
    let value = raw12 >> (2 * res);
    if (this.cfgr1 & 0x20) value <<= res === 3 ? 2 : 4 + 2 * res; // left alignment
    return value;
  }

  private finishConversion = (): void => {
    this.ev = null;
    const ch = this.sequence[this.seqIndex];
    const value = this.convert(ch);
    if (this.isr & ISR_EOC) {
      this.isr |= ISR_OVR;
      this.env.hint(
        'adc:ovr',
        'ADC overrun: a new conversion finished before the previous result was read from ADC1->DR, so a sample was lost.',
      );
      if (this.cfgr1 & (1 << 12)) this.dr = value;
    } else {
      this.dr = value;
      this.isr |= ISR_EOC;
    }
    this.seqIndex++;
    if (this.seqIndex >= this.sequence.length) {
      this.isr |= ISR_EOSEQ;
      if (this.cfgr1 & (1 << 13)) {
        this.seqIndex = 0;
        this.scheduleConversion();
      } else {
        this.cr &= ~4;
      }
    } else {
      this.scheduleConversion();
    }
    this.updateIrq();
  };

  private updateIrq(): void {
    this.env.setIrq((this.isr & this.ier & 0x9f) !== 0);
  }

  read32(off: number): number {
    switch (off) {
      case 0x00: return this.isr;
      case 0x04: return this.ier;
      case 0x08: return this.cr;
      case 0x0c: return this.cfgr1;
      case 0x10: return this.cfgr2;
      case 0x14: return this.smpr;
      case 0x20: return this.tr;
      case 0x28: return this.chselr;
      case 0x40:
        this.isr &= ~ISR_EOC;
        this.updateIrq();
        return this.dr;
      case 0x308: return this.ccr;
      default: return 0;
    }
  }

  peek32(off: number): number {
    if (off === 0x40) return this.dr;
    if (off === 0x00) return 0;
    return this.read32(off);
  }

  write32(off: number, value: number): void {
    const v = value >>> 0;
    switch (off) {
      case 0x00: this.isr &= ~(v & 0x9f); break; // write 1 to clear
      case 0x04: this.ier = v & 0x9f; break;
      case 0x08: this.writeCr(v); break;
      case 0x0c: this.cfgr1 = v; break;
      case 0x10: this.cfgr2 = v & 0xc0000000; break;
      case 0x14: this.smpr = v & 7; break;
      case 0x20: this.tr = v & 0x0fff0fff; break;
      case 0x28: this.chselr = v & 0x7ffff; break;
      case 0x308: this.ccr = v & 0x01c00000; break;
    }
    this.updateIrq();
  }

  private writeCr(v: number): void {
    if (v & 0x80000000) {
      // ADCAL: calibration, only allowed while the ADC is disabled
      if (this.cr & 1) {
        this.env.hint('adc:cal', 'ADCAL was set while the ADC is enabled (ADEN = 1); calibration only runs with the ADC disabled.');
      } else {
        this.cr |= 0x80000000;
        this.later(83 / this.adcHz(), () => {
          this.cr &= ~0x80000000;
        });
      }
    }
    if (v & 1 && !(this.cr & 1)) {
      if (this.cr & 0x80000000) {
        this.env.hint('adc:aden-cal', 'ADEN was set while calibration (ADCAL) is still running; wait for ADCAL to clear first.');
      }
      this.cr |= 1;
      this.later(4 / this.adcHz(), () => {
        if (this.cr & 1) {
          this.isr |= ISR_ADRDY;
          this.updateIrq();
        }
      });
    }
    if (v & 2 && this.cr & 1) {
      // ADDIS
      this.env.clock.cancel(this.ev);
      this.ev = null;
      this.cr &= ~(1 | 4);
      this.isr &= ~ISR_ADRDY;
    }
    if (v & 4 && !(this.cr & 4)) {
      if (!(this.cr & 1)) {
        this.env.hint(
          'adc:start',
          'ADSTART was ignored because the ADC is not enabled. Set ADEN and wait for the ADRDY flag before starting a conversion.',
        );
      } else {
        this.cr |= 4;
        this.startSequence();
      }
    }
    if (v & 0x10 && this.cr & 4) {
      // ADSTP
      this.env.clock.cancel(this.ev);
      this.ev = null;
      this.cr &= ~4;
    }
  }
}
