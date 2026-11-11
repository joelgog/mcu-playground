/**
 * I2C (the STM32F0 "v2" peripheral), master mode.
 *
 * A transfer is described in CR2 (address, direction, byte count) and started
 * with the START bit; the hardware then raises TXIS / RXNE for each byte and
 * finishes with TC, or with an automatic STOP when AUTOEND is set.
 * SCL and SDA are driven with real bit timing derived from TIMINGR, so a
 * transfer can be inspected in the pin trace.
 */
import { HintFn, Peripheral } from '../bus';
import { Clock } from '../clock';
import { AfMux } from './gpio';
import { WaveSeq } from './wave';

const ISR_TXE = 1 << 0;
const ISR_TXIS = 1 << 1;
const ISR_RXNE = 1 << 2;
const ISR_NACKF = 1 << 4;
const ISR_STOPF = 1 << 5;
const ISR_TC = 1 << 6;
const ISR_TCR = 1 << 7;
const ISR_BUSY = 1 << 15;

const CR2_RD_WRN = 1 << 10;
const CR2_START = 1 << 13;
const CR2_STOP = 1 << 14;
const CR2_RELOAD = 1 << 24;
const CR2_AUTOEND = 1 << 25;

/** The devices on the bus, as seen by the master. */
export interface I2cHost {
  /** Address phase. Returns true if a device acknowledges. */
  start(addr7: number, read: boolean): boolean;
  /** Master sends a byte. Returns true if the device acknowledges. */
  write(byte: number): boolean;
  /** Master reads a byte; masterAck tells the device whether more bytes will be requested. */
  read(masterAck: boolean): number;
  stop(): void;
  /** Level a device puts on SDA (1 = released). Used only for the waveform. */
  slaveSda(level: number): void;
}

export const EMPTY_I2C_BUS: I2cHost = {
  start: () => false,
  write: () => false,
  read: () => 0xff,
  stop: () => {},
  slaveSda: () => {},
};

export interface I2cEnv {
  clock: Clock;
  afmux: AfMux;
  setIrq: (level: boolean) => void;
  /** Frequency of the I2C kernel clock (HSI or SYSCLK, selected in RCC_CFGR3). */
  kernelHz: () => number;
  hint: HintFn;
}

type State = 'idle' | 'busy' | 'tx-wait' | 'rx-wait' | 'tc' | 'tcr';

export class I2c implements Peripheral {
  cr1 = 0;
  cr2 = 0;
  oar1 = 0;
  oar2 = 0;
  timingr = 0;
  isr = ISR_TXE;
  rxdr = 0;
  txdr = 0;
  host: I2cHost = EMPTY_I2C_BUS;

  private state: State = 'idle';
  private remaining = 0;
  private reading = false;
  private onBus = false;
  private txPending = false;
  private stopRequested = false;
  private seq: WaveSeq;
  private readonly sclSignal: string;
  private readonly sdaSignal: string;

  constructor(
    readonly name: string,
    private env: I2cEnv,
  ) {
    this.seq = new WaveSeq(env.clock);
    this.sclSignal = `${name}_SCL`;
    this.sdaSignal = `${name}_SDA`;
  }

  reset(): void {
    this.seq.cancel();
    this.cr1 = this.cr2 = this.oar1 = this.oar2 = this.timingr = this.rxdr = this.txdr = 0;
    this.isr = ISR_TXE;
    this.state = 'idle';
    this.onBus = false;
    this.txPending = false;
    this.stopRequested = false;
    this.env.afmux.setOutput(this.sclSignal, null);
    this.env.afmux.setOutput(this.sdaSignal, null);
    this.host.slaveSda(1);
    this.env.setIrq(false);
  }

  /** SCL frequency for the current TIMINGR value (0 if not configured). */
  sclHz(): number {
    const t = this.timing();
    return t.low + t.high > 0 ? this.env.clock.hz / (t.low + t.high) : 0;
  }

  /** Low and high time of SCL in CPU cycles. */
  private timing(): { low: number; high: number } {
    const presc = (this.timingr >>> 28) + 1;
    const scll = (this.timingr & 0xff) + 1;
    const sclh = ((this.timingr >>> 8) & 0xff) + 1;
    const unit = (presc / this.env.kernelHz()) * this.env.clock.hz;
    return { low: scll * unit, high: sclh * unit };
  }

  private scl = (level: number) => this.env.afmux.setOutput(this.sclSignal, level);
  private sda = (level: number) => this.env.afmux.setOutput(this.sdaSignal, level);

  // ------------------------------------------------------------ waveforms

  private addStart(repeated: boolean): void {
    const { low, high } = this.timing();
    if (repeated) {
      this.seq.add(low / 2, () => this.sda(1)).add(low / 2, () => this.scl(1)).add(high / 2, () => this.sda(0)).add(high / 2, () => this.scl(0));
    } else {
      this.seq.add(0, () => this.sda(0)).add(high / 2, () => this.scl(0));
    }
  }

  private addStop(): void {
    const { low, high } = this.timing();
    this.seq.add(low / 2, () => this.sda(0)).add(low / 2, () => this.scl(1)).add(high / 2, () => this.sda(1)).wait(high / 2);
  }

  /** Eight data bits MSB first plus the acknowledge bit; fromMaster says who drives the data. */
  private addByte(byte: number, fromMaster: boolean, ack: boolean): void {
    const { low, high } = this.timing();
    const host = this.host;
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >> i) & 1;
      this.seq
        .add(low / 2, () => {
          if (fromMaster) this.sda(bit);
          else {
            this.sda(1);
            host.slaveSda(bit);
          }
        })
        .add(low / 2, () => this.scl(1))
        .add(high, () => this.scl(0));
    }
    this.seq
      .add(low / 2, () => {
        // the receiver of the byte pulls SDA low to acknowledge
        if (fromMaster) {
          this.sda(1);
          host.slaveSda(ack ? 0 : 1);
        } else {
          host.slaveSda(1);
          this.sda(ack ? 0 : 1);
        }
      })
      .add(low / 2, () => this.scl(1))
      .add(high, () => {
        this.scl(0);
        host.slaveSda(1);
      });
  }

  // -------------------------------------------------------------- transfer

  private routed(): boolean {
    const af = this.env.afmux;
    return af.routedPins(this.sclSignal).length > 0 && af.routedPins(this.sdaSignal).length > 0;
  }

  private startTransfer(): void {
    const read = (this.cr2 & CR2_RD_WRN) !== 0;
    const addr7 = (this.cr2 >>> 1) & 0x7f;
    this.reading = read;
    this.remaining = (this.cr2 >>> 16) & 0xff;
    this.stopRequested = false;
    this.isr &= ~(ISR_TC | ISR_TCR | ISR_TXIS);
    this.isr |= ISR_BUSY;
    this.state = 'busy';

    if (this.timingr === 0) {
      this.env.hint(`${this.name}:timing`, `${this.name}->TIMINGR is 0, so the bus speed is undefined. Set it for your clock (0x10420F13 gives 100 kHz from the 8 MHz HSI).`);
    }
    let ack = false;
    if (!this.routed()) {
      this.env.hint(
        `${this.name}:pins`,
        `${this.name} started a transfer, but its pins are not connected. Put ${this.env.afmux.describeOptions(this.sclSignal)} (SCL) and ` +
          `${this.env.afmux.describeOptions(this.sdaSignal)} (SDA) into alternate-function mode, open-drain.`,
      );
    } else ack = this.host.start(addr7, read);

    this.addStart(this.onBus);
    this.onBus = true;
    this.addByte((addr7 << 1) | (read ? 1 : 0), true, ack);
    this.seq.run(() => {
      this.cr2 &= ~CR2_START;
      if (!ack) {
        this.isr |= ISR_NACKF;
        if (this.routed()) {
          this.env.hint(
            `${this.name}:nack:${addr7}`,
            `No device answered at I2C address 0x${addr7.toString(16).toUpperCase().padStart(2, '0')} (NACK). ` +
              `Check the address: SADD in CR2 holds the 7-bit address shifted left by one.`,
          );
        }
        this.sendStop();
      } else this.nextByte();
      this.updateIrq();
    });
  }

  /** Continue after the address or a data byte was acknowledged. */
  private nextByte(): void {
    if (this.stopRequested) return this.sendStop();
    if (this.remaining === 0) return this.finishBlock();
    if (this.reading) {
      if (this.isr & ISR_RXNE) {
        this.state = 'rx-wait';
        return;
      }
      this.receive();
    } else if (this.txPending) {
      this.transmit();
    } else {
      this.state = 'tx-wait';
      this.isr |= ISR_TXIS;
    }
  }

  private transmit(): void {
    this.state = 'busy';
    this.txPending = false;
    this.isr |= ISR_TXE;
    this.isr &= ~ISR_TXIS;
    const ack = this.host.write(this.txdr & 0xff);
    this.addByte(this.txdr & 0xff, true, ack);
    this.seq.run(() => {
      this.remaining--;
      if (!ack) {
        this.isr |= ISR_NACKF;
        this.sendStop();
      } else this.nextByte();
      this.updateIrq();
    });
  }

  private receive(): void {
    this.state = 'busy';
    // the master acknowledges every byte except the last one of the transfer
    const masterAck = this.remaining > 1 || (this.cr2 & CR2_RELOAD) !== 0;
    const byte = this.host.read(masterAck) & 0xff;
    this.addByte(byte, false, masterAck);
    this.seq.run(() => {
      this.remaining--;
      this.rxdr = byte;
      this.isr |= ISR_RXNE;
      this.nextByte();
      this.updateIrq();
    });
  }

  private finishBlock(): void {
    if (this.cr2 & CR2_RELOAD) {
      this.state = 'tcr';
      this.isr |= ISR_TCR;
    } else if (this.cr2 & CR2_AUTOEND) {
      this.sendStop();
    } else {
      this.state = 'tc';
      this.isr |= ISR_TC;
    }
  }

  private sendStop(): void {
    this.state = 'busy';
    this.isr &= ~(ISR_TC | ISR_TCR | ISR_TXIS);
    this.addStop();
    this.seq.run(() => {
      this.host.stop();
      this.onBus = false;
      this.state = 'idle';
      this.cr2 &= ~CR2_STOP;
      this.isr = (this.isr & ~ISR_BUSY) | ISR_STOPF;
      this.updateIrq();
    });
  }

  private updateIrq(): void {
    const cr1 = this.cr1;
    const isr = this.isr;
    const level =
      (cr1 & 0x02 && isr & ISR_TXIS) ||
      (cr1 & 0x04 && isr & ISR_RXNE) ||
      (cr1 & 0x10 && isr & ISR_NACKF) ||
      (cr1 & 0x20 && isr & ISR_STOPF) ||
      (cr1 & 0x40 && isr & (ISR_TC | ISR_TCR));
    this.env.setIrq((cr1 & 1) !== 0 && !!level);
  }

  // ------------------------------------------------------------ registers

  read32(off: number): number {
    switch (off) {
      case 0x00: return this.cr1;
      case 0x04: return this.cr2;
      case 0x08: return this.oar1;
      case 0x0c: return this.oar2;
      case 0x10: return this.timingr;
      case 0x18: return this.isr;
      case 0x24: {
        const v = this.rxdr;
        if (this.isr & ISR_RXNE) {
          this.isr &= ~ISR_RXNE;
          if (this.state === 'rx-wait') this.receive();
          this.updateIrq();
        }
        return v;
      }
      case 0x28: return this.txdr;
      default: return 0;
    }
  }

  peek32(off: number): number {
    return off === 0x24 ? this.rxdr : this.read32(off);
  }

  write32(off: number, value: number): void {
    const v = value >>> 0;
    switch (off) {
      case 0x00: {
        const was = this.cr1 & 1;
        this.cr1 = v;
        if (!(v & 1) && was) {
          // disabling the peripheral is a software reset of the state machine
          this.seq.cancel();
          this.state = 'idle';
          this.onBus = false;
          this.txPending = false;
          this.isr = ISR_TXE;
          this.env.afmux.setOutput(this.sclSignal, null);
          this.env.afmux.setOutput(this.sdaSignal, null);
          this.host.slaveSda(1);
        } else if (v & 1 && !was) {
          this.scl(1);
          this.sda(1);
          for (const pin of [...this.env.afmux.routedPins(this.sclSignal), ...this.env.afmux.routedPins(this.sdaSignal)]) {
            this.checkOpenDrain(pin);
          }
        }
        break;
      }
      case 0x04: this.writeCr2(v); break;
      case 0x08: this.oar1 = v; break;
      case 0x0c: this.oar2 = v; break;
      case 0x10: this.timingr = v; break;
      case 0x18: // ISR: writing 1 to TXE flushes the transmit register
        if (v & ISR_TXE) {
          this.txPending = false;
          this.isr |= ISR_TXE;
        }
        break;
      case 0x1c: // ICR: write 1 to clear
        this.isr &= ~(v & (ISR_NACKF | ISR_STOPF | 0x3f08));
        break;
      case 0x28:
        this.txdr = v & 0xff;
        this.isr &= ~(ISR_TXIS | ISR_TXE);
        this.txPending = true;
        if (this.state === 'tx-wait') this.transmit();
        break;
    }
    this.updateIrq();
  }

  private writeCr2(v: number): void {
    if (!(this.cr1 & 1)) {
      this.cr2 = v & ~(CR2_START | CR2_STOP);
      if (v & CR2_START) {
        this.env.hint(`${this.name}:pe`, `START was written to ${this.name}->CR2 while the peripheral is disabled. Set PE in CR1 first.`);
      }
      return;
    }
    const start = (v & CR2_START) !== 0;
    const stop = (v & CR2_STOP) !== 0;
    this.cr2 = v;
    if (this.state === 'tcr' && !start) {
      // new byte count after RELOAD
      this.isr &= ~ISR_TCR;
      this.remaining = (v >>> 16) & 0xff;
      this.state = 'busy';
      this.nextByte();
      return;
    }
    if (start) {
      if (this.state === 'idle' || this.state === 'tc' || this.state === 'tcr') this.startTransfer();
      else {
        this.cr2 &= ~CR2_START;
        this.env.hint(
          `${this.name}:busy`,
          `START was set on ${this.name} while the previous transfer is still in progress, and was ignored. ` +
            `Wait for TC or STOPF (or the BUSY flag to clear) before starting the next transfer.`,
        );
      }
    } else if (stop) {
      if (this.state === 'tc' || this.state === 'tcr' || this.state === 'tx-wait' || this.state === 'rx-wait') this.sendStop();
      else if (this.state === 'busy') this.stopRequested = true;
      else this.cr2 &= ~CR2_STOP;
    }
  }

  private checkOpenDrain(pin: string): void {
    // filled in by the MCU, which can see the GPIO configuration
    this.openDrainCheck(pin);
  }

  /** Set by the MCU: reports a hint if an I2C pin is not configured as open-drain. */
  openDrainCheck: (pin: string) => void = () => {};
}
