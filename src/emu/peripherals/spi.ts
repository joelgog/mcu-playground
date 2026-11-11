/**
 * SPI (the STM32F0 peripheral with 32-bit FIFOs), master mode.
 *
 * Things that trip people up on this family are modelled on purpose:
 *  - the data register must be accessed with the width of one frame: an 8-bit
 *    frame needs an 8-bit access (`*(volatile uint8_t *)&SPI2->DR`), a 16-bit
 *    access queues two bytes;
 *  - RXNE only signals a single received byte if FRXTH is set in CR2;
 *  - a master with software slave management needs SSI = 1, otherwise the
 *    peripheral reports a mode fault and falls back to slave mode.
 */
import { HintFn, Peripheral } from '../bus';
import { Clock } from '../clock';
import { AfMux } from './gpio';
import { WaveSeq } from './wave';

const CR1_CPHA = 1 << 0;
const CR1_CPOL = 1 << 1;
const CR1_MSTR = 1 << 2;
const CR1_SPE = 1 << 6;
const CR1_LSBFIRST = 1 << 7;
const CR1_SSI = 1 << 8;
const CR1_SSM = 1 << 9;
const CR2_SSOE = 1 << 2;
const CR2_FRXTH = 1 << 12;

const SR_RXNE = 1 << 0;
const SR_TXE = 1 << 1;
const SR_MODF = 1 << 5;
const SR_OVR = 1 << 6;
const SR_BSY = 1 << 7;

/** The devices on the bus, as seen by the master. */
export interface SpiHost {
  /**
   * One byte is clocked out (MSB first as seen on the wire); returns the byte
   * the selected device shifts back, or null if no device drives MISO.
   * mode = CPOL * 2 + CPHA.
   */
  transfer(mosi: number, mode: number): number | null;
  /** Level a device puts on MISO (null = released). Used only for the waveform. */
  slaveMiso(level: number | null): void;
}

export const EMPTY_SPI_BUS: SpiHost = {
  transfer: () => null,
  slaveMiso: () => {},
};

export interface SpiEnv {
  clock: Clock;
  afmux: AfMux;
  setIrq: (level: boolean) => void;
  /** HCLK cycles per PCLK cycle. */
  pclkDiv: () => number;
  hint: HintFn;
}

function reverse8(b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
  return r;
}

export class Spi implements Peripheral {
  cr1 = 0;
  cr2 = 0x0700;
  host: SpiHost = EMPTY_SPI_BUS;

  private tx: number[] = [];
  private rx: number[] = [];
  private flags = 0;
  private shifting = false;
  private seq: WaveSeq;
  private readonly sck: string;
  private readonly mosi: string;
  private readonly miso: string;

  constructor(
    readonly name: string,
    private env: SpiEnv,
  ) {
    this.seq = new WaveSeq(env.clock);
    this.sck = `${name}_SCK`;
    this.mosi = `${name}_MOSI`;
    this.miso = `${name}_MISO`;
  }

  reset(): void {
    this.seq.cancel();
    this.cr1 = 0;
    this.cr2 = 0x0700;
    this.tx = [];
    this.rx = [];
    this.flags = 0;
    this.shifting = false;
    this.env.afmux.setOutput(this.sck, null);
    this.env.afmux.setOutput(this.mosi, null);
    this.host.slaveMiso(null);
    this.env.setIrq(false);
  }

  /** Bytes per frame: 1 for data sizes up to 8 bits, otherwise 2. */
  private frameBytes(): number {
    return ((this.cr2 >>> 8) & 15) > 7 ? 2 : 1;
  }

  /** SCK frequency in Hz. */
  sckHz(): number {
    return this.env.clock.hz / this.bitCycles();
  }

  private bitCycles(): number {
    return this.env.pclkDiv() * (2 << ((this.cr1 >>> 3) & 7));
  }

  private active(): boolean {
    return (this.cr1 & (CR1_SPE | CR1_MSTR)) === (CR1_SPE | CR1_MSTR);
  }

  private sr(): number {
    let v = this.flags;
    const threshold = this.cr2 & CR2_FRXTH ? 1 : 2;
    if (this.rx.length >= threshold) v |= SR_RXNE;
    if (this.tx.length <= 2) v |= SR_TXE;
    if (this.shifting || this.tx.length > 0) v |= SR_BSY;
    v |= Math.min(3, this.rx.length) << 9;
    v |= Math.min(3, this.tx.length) << 11;
    return v;
  }

  private updateIrq(): void {
    const sr = this.sr();
    const level = (this.cr2 & 0x40 && sr & SR_RXNE) || (this.cr2 & 0x80 && sr & SR_TXE) || (this.cr2 & 0x20 && sr & (SR_MODF | SR_OVR));
    this.env.setIrq((this.cr1 & CR1_SPE) !== 0 && !!level);
  }

  private idleLines(): void {
    if (this.active()) {
      this.env.afmux.setOutput(this.sck, this.cr1 & CR1_CPOL ? 1 : 0);
      this.env.afmux.setOutput(this.mosi, 0);
    } else {
      this.env.afmux.setOutput(this.sck, null);
      this.env.afmux.setOutput(this.mosi, null);
    }
  }

  private pump(): void {
    if (this.shifting || !this.active() || this.tx.length === 0) return;
    const af = this.env.afmux;
    if (af.routedPins(this.sck).length === 0 || af.routedPins(this.mosi).length === 0) {
      this.env.hint(
        `${this.name}:pins`,
        `${this.name} is sending, but its pins are not connected. Put ${af.describeOptions(this.sck)} (SCK) and ${af.describeOptions(this.mosi)} (MOSI) ` +
          `into alternate-function mode.`,
      );
    }
    const routedOut = af.routedPins(this.sck).length > 0 && af.routedPins(this.mosi).length > 0;
    const routedIn = af.routedPins(this.miso).length > 0;
    this.shifting = true;
    const data = this.tx.shift()!;
    const lsbFirst = (this.cr1 & CR1_LSBFIRST) !== 0;
    const wire = lsbFirst ? reverse8(data) : data;
    const mode = (this.cr1 & CR1_CPOL ? 2 : 0) | (this.cr1 & CR1_CPHA ? 1 : 0);
    const reply = routedOut ? this.host.transfer(wire, mode) : null;
    const misoWire = reply === null ? 0xff : reply & 0xff;
    const received = routedIn ? (lsbFirst ? reverse8(misoWire) : misoWire) : 0;
    if (!routedIn && reply !== null) {
      this.env.hint(
        `${this.name}:miso`,
        `A device answered on MISO, but no pin is switched to ${this.name}_MISO, so the data read back is 0. Put ${af.describeOptions(this.miso)} into alternate-function mode.`,
      );
    }

    const bit = this.bitCycles();
    const idle = this.cr1 & CR1_CPOL ? 1 : 0;
    const cpha = (this.cr1 & CR1_CPHA) !== 0;
    const fast = bit < this.env.clock.hz / 1_000_000;
    if (fast) {
      // Above 1 MHz the individual bits are not drawn: one clock burst per byte keeps the simulation responsive.
      this.seq.add(0, () => af.setOutput(this.mosi, (wire >> 7) & 1)).add(bit * 4, () => af.setOutput(this.sck, idle ^ 1)).add(bit * 4, () => af.setOutput(this.sck, idle));
    } else {
      for (let i = 7; i >= 0; i--) {
        const out = (wire >> i) & 1;
        const inp = reply === null ? null : (misoWire >> i) & 1;
        if (cpha) {
          this.seq
            .add(i === 7 ? 0 : bit / 2, () => {
              af.setOutput(this.sck, idle ^ 1);
              af.setOutput(this.mosi, out);
              this.host.slaveMiso(inp);
            })
            .add(bit / 2, () => af.setOutput(this.sck, idle));
        } else {
          this.seq
            .add(i === 7 ? 0 : bit / 2, () => {
              af.setOutput(this.sck, idle);
              af.setOutput(this.mosi, out);
              this.host.slaveMiso(inp);
            })
            .add(bit / 2, () => af.setOutput(this.sck, idle ^ 1));
        }
      }
      this.seq.add(bit / 2, () => af.setOutput(this.sck, idle));
    }
    this.seq.run(() => {
      this.shifting = false;
      if (this.rx.length >= 4) {
        this.flags |= SR_OVR;
        this.env.hint(
          `${this.name}:ovr`,
          `${this.name} receive overrun: four bytes arrived without DR being read. In SPI every byte sent also receives one, so read DR after each transfer.`,
        );
      } else this.rx.push(received);
      if (this.tx.length > 0) this.pump();
      else this.host.slaveMiso(null);
      this.updateIrq();
    });
  }

  private pushTx(byte: number): void {
    if (this.tx.length >= 4) return;
    this.tx.push(byte & 0xff);
  }

  private popRx(): number {
    return this.rx.length ? this.rx.shift()! : 0;
  }

  // ------------------------------------------------------------ registers

  read32(off: number): number {
    switch (off) {
      case 0x00: return this.cr1;
      case 0x04: return this.cr2;
      case 0x08: {
        const v = this.sr();
        if (!(v & SR_RXNE) && this.rx.length === 1 && !this.shifting && this.frameBytes() === 1) {
          this.env.hint(
            `${this.name}:frxth`,
            `${this.name} has received one byte, but RXNE stays 0 because FRXTH is 0 (the flag then waits for two bytes). ` +
              `Set SPI_CR2_FRXTH for 8-bit frames.`,
          );
        }
        return v;
      }
      case 0x0c: {
        // a 16/32-bit access pops two bytes when frames are 8 bits wide
        const first = this.popRx();
        const second = this.rx.length ? this.popRx() : 0;
        if (this.flags & SR_OVR) this.flags &= ~SR_OVR;
        this.updateIrq();
        // 16-bit frames arrive high byte first; packed 8-bit frames put the first byte in the low half
        return this.frameBytes() === 2 ? (first << 8) | second : first | (second << 8);
      }
      case 0x10: return 7;
      default: return 0;
    }
  }

  peek32(off: number): number {
    if (off === 0x0c) return this.rx[0] ?? 0;
    if (off === 0x08) return this.sr();
    return this.read32(off);
  }

  readByte(off: number): number {
    if (off === 0x0c) {
      const v = this.popRx();
      this.updateIrq();
      return v;
    }
    return (this.peek32(off & ~3) >>> ((off & 3) * 8)) & 0xff;
  }

  writeByte(off: number, value: number): void {
    if (off === 0x0c) {
      this.pushTx(value);
      this.pump();
      this.updateIrq();
      return;
    }
    const aligned = off & ~3;
    const sh = (off & 3) * 8;
    this.write32(aligned, (this.peek32(aligned) & ~(0xff << sh)) | (value << sh));
  }

  write32(off: number, value: number): void {
    const v = value >>> 0;
    switch (off) {
      case 0x00: {
        this.cr1 = v & 0xffff;
        if (this.cr1 & CR1_MSTR && this.cr1 & CR1_SPE) {
          const nssOk = (this.cr1 & CR1_SSM && this.cr1 & CR1_SSI) || (!(this.cr1 & CR1_SSM) && this.cr2 & CR2_SSOE);
          if (!nssOk) {
            this.flags |= SR_MODF;
            this.cr1 &= ~(CR1_MSTR | CR1_SPE);
            this.env.hint(
              `${this.name}:modf`,
              `${this.name} dropped out of master mode (mode fault, MODF). With software slave management (SSM = 1) the internal NSS must be held high: ` +
                `set SSI together with SSM in CR1.`,
            );
          }
        }
        if (!(this.cr1 & CR1_SPE)) {
          this.seq.cancel();
          this.shifting = false;
          this.tx = [];
          this.rx = [];
          this.host.slaveMiso(null);
        }
        if (!this.shifting) this.idleLines();
        this.pump();
        break;
      }
      case 0x04:
        this.cr2 = v & 0x7fff;
        break;
      case 0x08:
        break;
      case 0x0c:
        if (this.frameBytes() === 1) {
          this.env.hint(
            `${this.name}:dr16`,
            `${this.name}->DR was written with a 16-bit access while the frame size is 8 bits, so two bytes were queued (the second one is the upper byte, usually 0). ` +
              `Write through an 8-bit pointer: *(volatile uint8_t *)&${this.name}->DR = value;`,
          );
        }
        // high byte first on the wire for 16-bit frames, low byte first for packed 8-bit frames
        if (this.frameBytes() === 2) {
          this.pushTx(v >>> 8);
          this.pushTx(v);
        } else {
          this.pushTx(v);
          this.pushTx(v >>> 8);
        }
        this.pump();
        break;
    }
    this.updateIrq();
  }
}
