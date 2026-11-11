/** Devices on the I2C and SPI buses. */
import type { Mcu } from '../emu/mcu';
import { I2cBus, SpiBus, type I2cSlave, type SpiSlave } from './buses';
import { Device, type DeviceSpec, type DeviceState } from './devices';
import { VDD } from './net';

/**
 * TMP102-style digital temperature sensor at I2C address 0x48.
 * Write one byte to select a register, then read two bytes (MSB first).
 * Register 0 holds the temperature as a signed 12-bit value in the upper bits,
 * 0.0625 C per count.
 */
export class Tmp102 extends Device implements I2cSlave {
  readonly address = 0x48;
  tempC: number;
  private pointer = 0;
  private first = true;
  private index = 0;
  private regs = [0, 0x60a0, 0x4b00, 0x5000];
  /** Temperature reads started so far (for checks). */
  reads = 0;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.tempC = this.opt('tempC', 23.5);
    I2cBus.for(mcu, spec.pins.scl, spec.pins.sda).attach(this);
  }
  /** Raw content of the temperature register. */
  raw(): number {
    return (Math.round(this.tempC / 0.0625) << 4) & 0xffff;
  }
  start(read: boolean): boolean {
    this.first = true;
    this.index = 0;
    if (read && this.pointer === 0) this.reads++;
    return true;
  }
  write(byte: number): boolean {
    if (this.first) {
      this.pointer = byte & 3;
      this.first = false;
    } else if (this.pointer !== 0) {
      const shift = this.index === 0 ? 8 : 0;
      this.regs[this.pointer] = (this.regs[this.pointer] & ~(0xff << shift)) | (byte << shift);
      this.index ^= 1;
    }
    return true;
  }
  read(): number {
    const value = this.pointer === 0 ? this.raw() : this.regs[this.pointer];
    const byte = this.index === 0 ? value >> 8 : value & 0xff;
    this.index ^= 1;
    return byte & 0xff;
  }
  stop(): void {}
  input(name: string, value: number): void {
    if (name === 'tempC') this.tempC = Math.max(-40, Math.min(125, value));
  }
  state(): DeviceState {
    return { tempC: this.tempC, raw: this.raw(), reads: this.reads };
  }
}

/**
 * 24C02-style EEPROM at I2C address 0x50: 256 bytes, 8-byte pages.
 * Write: memory address, then data (wraps inside the page). The write is
 * committed at the STOP and takes 5 ms, during which the chip does not answer.
 * Read: set the address with a write, then read; the address auto-increments.
 */
export class Eeprom extends Device implements I2cSlave {
  readonly address = 0x50;
  readonly memory = new Uint8Array(256).fill(0xff);
  private pointer = 0;
  private first = true;
  private pending: Array<[number, number]> = [];
  private busyUntil = 0;
  writes = 0;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    I2cBus.for(mcu, spec.pins.scl, spec.pins.sda).attach(this);
  }
  private busy(): boolean {
    return this.clock.seconds() < this.busyUntil;
  }
  start(): boolean {
    if (this.busy()) return false;
    this.first = true;
    this.pending = [];
    return true;
  }
  write(byte: number): boolean {
    if (this.first) {
      this.pointer = byte;
      this.first = false;
    } else {
      this.pending.push([this.pointer, byte]);
      this.pointer = (this.pointer & 0xf8) | ((this.pointer + 1) & 7); // wraps within the 8-byte page
    }
    return true;
  }
  read(): number {
    const v = this.memory[this.pointer];
    this.pointer = (this.pointer + 1) & 0xff;
    return v;
  }
  stop(): void {
    if (this.pending.length === 0) return;
    for (const [addr, value] of this.pending) this.memory[addr] = value;
    this.pending = [];
    this.writes++;
    this.busyUntil = this.clock.seconds() + 0.005;
  }
  state(): DeviceState {
    const head = Array.from(this.memory.subarray(0, 8), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    return { writes: this.writes, busy: this.busy(), head };
  }
}

/**
 * 74HC595 shift register driving eight LEDs. Data is shifted in on SCK (MSB
 * first: the first bit ends up on output Q7) and appears on the LEDs when the
 * latch pin goes from low to high.
 */
export class LedBar extends Device implements SpiSlave {
  private shift = 0;
  outputs = 0;
  /** Number of latch pulses so far. */
  latches = 0;
  /** Every value latched so far, oldest first (for checks). */
  history: number[] = [];
  /** Time in seconds of each entry in history. */
  historyT: number[] = [];
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    SpiBus.for(mcu).attach(this);
    const latch = this.net('latch');
    latch.drive(this, null, 0); // pull-down so the latch input never floats
    let last = latch.level;
    latch.onChange((n) => {
      if (n.level === last) return;
      last = n.level;
      if (n.level) {
        this.outputs = this.shift;
        this.latches++;
        if (this.history.length < 4096) {
          this.history.push(this.outputs);
          this.historyT.push(this.clock.seconds());
        }
      }
    });
  }
  clocked(mosi: number, mode: number): number | null {
    if (mode === 1 || mode === 2) {
      // data changes on the edge the register samples on: every bit arrives one position late
      this.shift = ((this.shift << 7) | (mosi >> 1)) & 0xff;
      this.mcu.addHint(
        'ledbar:mode',
        'The shift register samples data on the rising clock edge, which needs SPI mode 0 or 3 (CPOL and CPHA equal). With the current mode the bits arrive shifted by one.',
      );
    } else this.shift = mosi & 0xff;
    return null;
  }
  state(): DeviceState {
    return { value: this.outputs, leds: Array.from({ length: 8 }, (_, i) => (this.outputs >> i) & 1), latches: this.latches };
  }
}

/**
 * LIS3DH-style 3-axis accelerometer on SPI (mode 0 or 3, chip select active low).
 * First byte: bit 7 = read, bit 6 = auto-increment, bits 5..0 = register.
 * WHO_AM_I (0x0F) reads 0x33. The outputs stay 0 until a data rate is selected
 * in CTRL_REG1 (0x20). OUT_X_L..OUT_Z_H (0x28..0x2D) are little-endian, signed,
 * left-justified 12-bit values: (int16_t)raw >> 4 is the acceleration in mg.
 */
export class Accel extends Device implements SpiSlave {
  tiltX: number;
  tiltY: number;
  private regs = new Uint8Array(0x40);
  private phase: 'command' | 'data' = 'command';
  private addr = 0;
  private readMode = false;
  private increment = false;
  /** Reads that started at the first output register (for checks). */
  outputReads = 0;
  constructor(spec: DeviceSpec, mcu: Mcu) {
    super(spec, mcu);
    this.tiltX = this.opt('tiltX', 0);
    this.tiltY = this.opt('tiltY', 0);
    this.regs[0x0f] = 0x33;
    this.regs[0x20] = 0x07;
    const cs = this.net('cs');
    cs.drive(this, null, VDD); // pull-up: deselected until the MCU drives CS low
    SpiBus.for(mcu).attach(this, this.net('miso'));
    let last = cs.level;
    cs.onChange((n) => {
      if (n.level === last) return;
      last = n.level;
      this.phase = 'command';
    });
  }
  /** Acceleration in mg on each axis for the current tilt (1 g straight down when flat). */
  mg(): [number, number, number] {
    const ax = Math.sin((this.tiltX * Math.PI) / 180);
    const ay = Math.sin((this.tiltY * Math.PI) / 180);
    const az = Math.sqrt(Math.max(0, 1 - ax * ax - ay * ay));
    return [Math.round(ax * 1000), Math.round(ay * 1000), Math.round(az * 1000)];
  }
  enabled(): boolean {
    return (this.regs[0x20] & 0xf0) !== 0;
  }
  private readReg(addr: number): number {
    if (addr >= 0x28 && addr <= 0x2d) {
      if (!this.enabled()) return 0;
      const axis = (addr - 0x28) >> 1;
      const raw = (this.mg()[axis] << 4) & 0xffff;
      return (addr & 1 ? raw >> 8 : raw) & 0xff;
    }
    if (addr === 0x27) return this.enabled() ? 0x0f : 0;
    return this.regs[addr & 0x3f];
  }
  clocked(mosi: number, mode: number): number | null {
    if (this.net('cs').level) return null;
    if (mode === 1 || mode === 2) {
      this.mcu.addHint('accel:mode', 'The accelerometer needs SPI mode 0 or 3 (CPOL and CPHA equal). With the current mode it returns garbage.');
      return 0xa5;
    }
    if (this.phase === 'command') {
      this.readMode = (mosi & 0x80) !== 0;
      this.increment = (mosi & 0x40) !== 0;
      this.addr = mosi & 0x3f;
      this.phase = 'data';
      if (this.readMode && this.addr === 0x28) this.outputReads++;
      return 0xff;
    }
    let out = 0xff;
    if (this.readMode) out = this.readReg(this.addr);
    else if (this.addr >= 0x1e && this.addr < 0x27) this.regs[this.addr] = mosi;
    if (this.increment) this.addr = (this.addr + 1) & 0x3f;
    return out;
  }
  input(name: string, value: number): void {
    if (name === 'tiltX') this.tiltX = Math.max(-90, Math.min(90, value));
    else if (name === 'tiltY') this.tiltY = Math.max(-90, Math.min(90, value));
  }
  state(): DeviceState {
    const [x, y, z] = this.mg();
    return { tiltX: this.tiltX, tiltY: this.tiltY, x, y, z, enabled: this.enabled(), selected: this.net('cs').level === 0 };
  }
}

export function createBusDevice(spec: DeviceSpec, mcu: Mcu): Device | null {
  switch (spec.kind) {
    case 'tmp102': return new Tmp102(spec, mcu);
    case 'eeprom': return new Eeprom(spec, mcu);
    case 'ledbar': return new LedBar(spec, mcu);
    case 'accel': return new Accel(spec, mcu);
    default: return null;
  }
}
