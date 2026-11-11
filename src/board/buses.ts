/** The I2C and SPI buses on the board: they connect the MCU peripherals to the bus devices. */
import type { Mcu } from '../emu/mcu';
import type { I2cHost } from '../emu/peripherals/i2c';
import type { SpiHost } from '../emu/peripherals/spi';
import { Net, VDD } from './net';

export interface I2cSlave {
  readonly address: number;
  /** Address matched. Return false to not acknowledge (e.g. while busy). */
  start(read: boolean): boolean;
  write(byte: number): boolean;
  read(): number;
  stop(): void;
}

const i2cBuses = new WeakMap<Mcu, I2cBus>();
const spiBuses = new WeakMap<Mcu, SpiBus>();

export class I2cBus implements I2cHost {
  private slaves: I2cSlave[] = [];
  private current: I2cSlave | null = null;
  private readonly sda: Net;
  private readonly owner = { role: 'i2c device' };

  private constructor(mcu: Mcu, sclPin: string, sdaPin: string) {
    this.sda = mcu.net(sdaPin);
    // 4.7k pull-ups to 3V3 on both lines
    mcu.net(sclPin).drive({ role: 'scl pull-up' }, null, VDD);
    this.sda.drive({ role: 'sda pull-up' }, null, VDD);
    mcu.i2c1.host = this;
  }

  static for(mcu: Mcu, sclPin: string, sdaPin: string): I2cBus {
    let bus = i2cBuses.get(mcu);
    if (!bus) i2cBuses.set(mcu, (bus = new I2cBus(mcu, sclPin, sdaPin)));
    return bus;
  }

  attach(slave: I2cSlave): void {
    this.slaves.push(slave);
  }

  start(addr7: number, read: boolean): boolean {
    this.current = this.slaves.find((s) => s.address === addr7) ?? null;
    if (this.current && !this.current.start(read)) this.current = null;
    return this.current !== null;
  }
  write(byte: number): boolean {
    return this.current ? this.current.write(byte) : false;
  }
  read(): number {
    return this.current ? this.current.read() : 0xff;
  }
  stop(): void {
    for (const s of this.slaves) s.stop();
    this.current = null;
  }
  slaveSda(level: number): void {
    this.sda.drive(this.owner, level ? null : 0);
  }
}

export interface SpiSlave {
  /** One byte was clocked. Return the byte shifted out on MISO, or null if this device is not driving MISO. */
  clocked(mosi: number, mode: number): number | null;
}

export class SpiBus implements SpiHost {
  private slaves: SpiSlave[] = [];
  private miso: Net | null = null;
  private readonly owner = { role: 'spi device' };

  private constructor(mcu: Mcu) {
    mcu.spi2.host = this;
  }

  static for(mcu: Mcu): SpiBus {
    let bus = spiBuses.get(mcu);
    if (!bus) spiBuses.set(mcu, (bus = new SpiBus(mcu)));
    return bus;
  }

  attach(slave: SpiSlave, misoNet?: Net): void {
    this.slaves.push(slave);
    if (misoNet) this.miso = misoNet;
  }

  transfer(mosi: number, mode: number): number | null {
    let reply: number | null = null;
    for (const s of this.slaves) {
      const r = s.clocked(mosi, mode);
      if (r !== null) reply = r;
    }
    return reply;
  }
  slaveMiso(level: number | null): void {
    this.miso?.drive(this.owner, level === null ? null : level ? VDD : 0);
  }
}
