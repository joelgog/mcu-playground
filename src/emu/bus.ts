/**
 * Memory bus of the simulated STM32F072RB.
 *
 *   0x0000_0000  flash alias (boot from main flash)
 *   0x0800_0000  flash, 128 KiB
 *   0x1FFF_C800  system memory / factory calibration values
 *   0x2000_0000  SRAM, 16 KiB
 *   0x4000_0000  peripherals (1 KiB blocks)
 *   0xE000_E000  Cortex-M system control space (SysTick, NVIC, SCB)
 */

export const FLASH_BASE = 0x08000000;
export const FLASH_SIZE = 128 * 1024;
export const RAM_BASE = 0x20000000;
export const RAM_SIZE = 16 * 1024;
export const SYSMEM_BASE = 0x1fffc800;
export const SYSMEM_SIZE = 0x3800;

export type FaultKind = 'bus' | 'unaligned' | 'undefined' | 'invstate' | 'excreturn' | 'svc' | 'vector';

export class CpuFault extends Error {
  constructor(
    public kind: FaultKind,
    public addr: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Peripheral {
  readonly name: string;
  /** Read a 32-bit register (may have side effects such as clearing flags). */
  read32(offset: number): number;
  /** Read without side effects; defaults to read32. */
  peek32?(offset: number): number;
  write32(offset: number, value: number): void;
  /** Optional byte-wide access for registers whose behaviour depends on the access size (SPI data register). */
  readByte?(offset: number): number;
  writeByte?(offset: number, value: number): void;
  reset(): void;
}

interface Mapping {
  p: Peripheral;
  clocked: () => boolean;
}

export interface SystemControlSpace {
  scsRead(addr: number): number;
  scsWrite(addr: number, value: number): void;
}

export type HintFn = (id: string, message: string) => void;

const hex = (n: number) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** Peripherals that exist on the real chip but are not simulated: access is tolerated with a hint. */
const UNSIMULATED: Array<[number, string]> = [
  [0x40002800, 'RTC'], [0x40002c00, 'WWDG'], [0x40004800, 'USART3'],
  [0x40004c00, 'USART4'], [0x40005800, 'I2C2'], [0x40005c00, 'USB'],
  [0x40006400, 'CAN'], [0x40006c00, 'CRS'], [0x40007000, 'PWR'], [0x40007400, 'DAC'],
  [0x40007800, 'CEC'], [0x40012c00, 'TIM1'], [0x40013000, 'SPI1'], [0x40013800, 'USART1'],
  [0x40014000, 'TIM15'], [0x40014400, 'TIM16'], [0x40014800, 'TIM17'], [0x40015800, 'DBGMCU'],
  [0x40020000, 'DMA1'], [0x40023000, 'CRC'], [0x40024000, 'TSC'], [0x48001000, 'GPIOE'],
];

export class Bus {
  readonly flash = new Uint8Array(FLASH_SIZE);
  readonly ram = new Uint8Array(RAM_SIZE);
  readonly sysmem = new Uint8Array(SYSMEM_SIZE);
  private flash16 = new Uint16Array(this.flash.buffer);
  private flash32 = new Int32Array(this.flash.buffer);
  private ram16 = new Uint16Array(this.ram.buffer);
  private ram32 = new Int32Array(this.ram.buffer);
  private sysView = new DataView(this.sysmem.buffer);
  private periph = new Map<number, Mapping>();
  private unsimulated = new Map<number, string>(UNSIMULATED.map(([a, n]) => [a >>> 10, n]));
  scs: SystemControlSpace | null = null;
  hint: HintFn = () => {};

  constructor() {
    this.flash.fill(0xff);
    // Factory calibration values (datasheet typical): TS_CAL1 @30C, TS_CAL2 @110C, VREFINT_CAL, unique ID.
    this.sysmem.fill(0xff);
    this.sysView.setUint16(0x1ffff7b8 - SYSMEM_BASE, 1776, true);
    this.sysView.setUint16(0x1ffff7c2 - SYSMEM_BASE, 1347, true);
    this.sysView.setUint16(0x1ffff7ba - SYSMEM_BASE, 1526, true);
    this.sysView.setUint32(0x1ffff7ac - SYSMEM_BASE, 0x00470031, true);
    this.sysView.setUint32(0x1ffff7b0 - SYSMEM_BASE, 0x4d435550, true);
    this.sysView.setUint32(0x1ffff7b4 - SYSMEM_BASE, 0x20313233, true);
    this.sysView.setUint16(0x1ffff7cc - SYSMEM_BASE, 128, true); // flash size in KiB
  }

  map(base: number, p: Peripheral, clocked: () => boolean = () => true): void {
    this.periph.set(base >>> 10, { p, clocked });
  }

  resetMemory(): void {
    this.ram.fill(0);
  }

  // ---------------------------------------------------------------- reads

  fetch16(addr: number): number {
    const a = addr >>> 0;
    if (((a - FLASH_BASE) >>> 0) < FLASH_SIZE) return this.flash16[(a - FLASH_BASE) >> 1];
    if (((a - RAM_BASE) >>> 0) < RAM_SIZE) return this.ram16[(a - RAM_BASE) >> 1];
    if (a < FLASH_SIZE) return this.flash16[a >> 1];
    throw new CpuFault('bus', a, `The program counter jumped to ${hex(a)}, where there is no code.`);
  }

  read32(addr: number): number {
    const a = addr >>> 0;
    if (((a - RAM_BASE) >>> 0) < RAM_SIZE) {
      if (a & 3) this.unaligned(a, 4, false);
      return this.ram32[(a - RAM_BASE) >> 2];
    }
    if (((a - FLASH_BASE) >>> 0) < FLASH_SIZE) {
      if (a & 3) this.unaligned(a, 4, false);
      return this.flash32[(a - FLASH_BASE) >> 2];
    }
    if (a & 3) this.unaligned(a, 4, false);
    if (a < FLASH_SIZE) return this.flash32[a >> 2];
    return this.slowRead32(a);
  }

  read16(addr: number): number {
    const a = addr >>> 0;
    if (((a - RAM_BASE) >>> 0) < RAM_SIZE) {
      if (a & 1) this.unaligned(a, 2, false);
      return this.ram16[(a - RAM_BASE) >> 1];
    }
    if (((a - FLASH_BASE) >>> 0) < FLASH_SIZE) {
      if (a & 1) this.unaligned(a, 2, false);
      return this.flash16[(a - FLASH_BASE) >> 1];
    }
    if (a & 1) this.unaligned(a, 2, false);
    if (a < FLASH_SIZE) return this.flash16[a >> 1];
    return (this.slowRead32(a & ~3) >>> ((a & 3) * 8)) & 0xffff;
  }

  read8(addr: number): number {
    const a = addr >>> 0;
    if (((a - RAM_BASE) >>> 0) < RAM_SIZE) return this.ram[a - RAM_BASE];
    if (((a - FLASH_BASE) >>> 0) < FLASH_SIZE) return this.flash[a - FLASH_BASE];
    if (a < FLASH_SIZE) return this.flash[a];
    if (a >= 0x40000000 && a < 0x50000000) {
      const m = this.periph.get(a >>> 10);
      if (m && m.p.readByte && m.clocked()) return m.p.readByte(a & 0x3ff) & 0xff;
    }
    return (this.slowRead32(a & ~3) >>> ((a & 3) * 8)) & 0xff;
  }

  // --------------------------------------------------------------- writes

  write32(addr: number, value: number): void {
    const a = addr >>> 0;
    if (((a - RAM_BASE) >>> 0) < RAM_SIZE) {
      if (a & 3) this.unaligned(a, 4, true);
      this.ram32[(a - RAM_BASE) >> 2] = value;
      return;
    }
    if (a & 3) this.unaligned(a, 4, true);
    this.slowWrite32(a, value, 0xffffffff);
  }

  write16(addr: number, value: number): void {
    const a = addr >>> 0;
    if (((a - RAM_BASE) >>> 0) < RAM_SIZE) {
      if (a & 1) this.unaligned(a, 2, true);
      this.ram16[(a - RAM_BASE) >> 1] = value;
      return;
    }
    if (a & 1) this.unaligned(a, 2, true);
    const sh = (a & 3) * 8;
    this.slowWrite32(a & ~3, (value & 0xffff) << sh, 0xffff << sh);
  }

  write8(addr: number, value: number): void {
    const a = addr >>> 0;
    if (((a - RAM_BASE) >>> 0) < RAM_SIZE) {
      this.ram[a - RAM_BASE] = value;
      return;
    }
    if (a >= 0x40000000 && a < 0x50000000) {
      const m = this.periph.get(a >>> 10);
      if (m && m.p.writeByte && m.clocked()) {
        m.p.writeByte(a & 0x3ff, value & 0xff);
        return;
      }
    }
    const sh = (a & 3) * 8;
    this.slowWrite32(a & ~3, (value & 0xff) << sh, 0xff << sh);
  }

  // ------------------------------------------------------------ internals

  private unaligned(a: number, size: number, write: boolean): never {
    throw new CpuFault(
      'unaligned',
      a,
      `Unaligned ${size * 8}-bit ${write ? 'write to' : 'read from'} ${hex(a)}. ` +
        `A Cortex-M0 cannot access a ${size}-byte value at an address that is not a multiple of ${size}.`,
    );
  }

  private slowRead32(a: number): number {
    if (a >= 0x40000000 && a < 0x50000000) {
      const m = this.periph.get(a >>> 10);
      if (m) {
        if (!m.clocked()) {
          this.hint(
            `noclk:${m.p.name}`,
            `${m.p.name} was read while its clock is off, so it returned 0. Enable the clock in RCC first.`,
          );
          return 0;
        }
        return m.p.read32(a & 0x3fc) | 0;
      }
      const name = this.unsimulated.get(a >>> 10);
      if (name) {
        this.hint(`unsim:${name}`, `${name} is not simulated in this playground; reads return 0 and writes are ignored.`);
        return 0;
      }
    } else if (a >= 0xe000e000 && a < 0xe000f000 && this.scs) {
      return this.scs.scsRead(a) | 0;
    } else if (((a - SYSMEM_BASE) >>> 0) < SYSMEM_SIZE) {
      return this.sysView.getInt32(a - SYSMEM_BASE, true);
    }
    throw new CpuFault('bus', a, `Read from ${hex(a)}, which is not a valid memory address${describeAddr(a)}.`);
  }

  private slowWrite32(a: number, value: number, mask: number): void {
    if (a >= 0x40000000 && a < 0x50000000) {
      const m = this.periph.get(a >>> 10);
      if (m) {
        if (!m.clocked()) {
          this.hint(
            `noclk:${m.p.name}`,
            `A write to ${m.p.name} was ignored because its clock is off. Enable the clock in RCC first.`,
          );
          return;
        }
        const off = a & 0x3fc;
        if (mask !== (0xffffffff | 0) && mask !== 0xffffffff) {
          const cur = m.p.peek32 ? m.p.peek32(off) : m.p.read32(off);
          value = (cur & ~mask) | (value & mask);
        }
        m.p.write32(off, value | 0);
        return;
      }
      const name = this.unsimulated.get(a >>> 10);
      if (name) {
        this.hint(`unsim:${name}`, `${name} is not simulated in this playground; reads return 0 and writes are ignored.`);
        return;
      }
    } else if (a >= 0xe000e000 && a < 0xe000f000 && this.scs) {
      if (mask !== (0xffffffff | 0) && mask !== 0xffffffff) {
        value = (this.scs.scsRead(a) & ~mask) | (value & mask);
      }
      this.scs.scsWrite(a, value | 0);
      return;
    } else if (((a - FLASH_BASE) >>> 0) < FLASH_SIZE || a < FLASH_SIZE) {
      this.hint(
        'flashwrite',
        `A write to flash memory at ${hex(a)} was ignored. Flash is read-only at run time ` +
          `(is a pointer aimed at a const or string literal?).`,
      );
      return;
    }
    throw new CpuFault('bus', a, `Write to ${hex(a)}, which is not a valid memory address${describeAddr(a)}.`);
  }
}

function describeAddr(a: number): string {
  if (a < 0x1000 || a >= 0xfffff000) return ' (looks like a NULL or uninitialised pointer)';
  if (a >= RAM_BASE && a < RAM_BASE + 0x10000) return ' (just outside the 16 KiB of RAM: stack overflow or buffer overrun?)';
  return '';
}
