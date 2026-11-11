/** RCC: reset and clock control. Clock gating for peripherals and the system clock tree. */
import { HintFn, Peripheral } from '../bus';
import { Clock } from '../clock';

const HSI = 8_000_000;
const HSE = 8_000_000;
const HSI48 = 48_000_000;
const AHB_DIV = [1, 1, 1, 1, 1, 1, 1, 1, 2, 4, 8, 16, 64, 128, 256, 512];
const APB_DIV = [1, 1, 1, 1, 2, 4, 8, 16];

export type ResetCause = 'power' | 'pin' | 'software' | 'iwdg';

export class Rcc implements Peripheral {
  readonly name = 'RCC';
  cr = 0x83;
  cfgr = 0;
  cir = 0;
  ahbenr = 0x14;
  apb2enr = 0;
  apb1enr = 0;
  bdcr = 0;
  csr = 0x0c000000;
  cfgr2 = 0;
  cfgr3 = 0;
  cr2 = 0x80;

  sysclk = HSI;
  hclk = HSI;
  pclk = HSI;
  /** FLASH->ACR latency bits, provided by the flash interface for the wait-state hint. */
  flashLatency: () => number = () => 0;
  private listeners: Array<() => void> = [];

  constructor(
    private clock: Clock,
    private hint: HintFn,
  ) {}

  onClockChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** HCLK cycles per timer clock tick (timers run at PCLK, or 2x PCLK when the APB prescaler is not 1). */
  timerClkDiv(): number {
    const ppre = APB_DIV[(this.cfgr >> 8) & 7];
    return ppre === 1 ? 1 : ppre / 2;
  }

  /** HCLK cycles per PCLK cycle. */
  pclkDiv(): number {
    return APB_DIV[(this.cfgr >> 8) & 7];
  }

  reset(cause: ResetCause = 'power'): void {
    const flags =
      cause === 'power' ? 0x0c000000 : cause === 'pin' ? 0x04000000 : cause === 'software' ? 0x14000000 : 0x24000000;
    this.csr = cause === 'power' ? flags : (this.csr & 0xff000000) | flags;
    this.csr |= this.csr & 1 ? 2 : 0;
    this.cr = 0x83;
    this.cfgr = 0;
    this.cir = 0;
    this.ahbenr = 0x14;
    this.apb2enr = 0;
    this.apb1enr = 0;
    this.cfgr2 = 0;
    this.cfgr3 = 0;
    this.cr2 = 0x80;
    this.updateClocks();
  }

  private pllOut(): number {
    const mul = Math.min(16, ((this.cfgr >> 18) & 15) + 2);
    const prediv = (this.cfgr2 & 15) + 1;
    switch ((this.cfgr >> 15) & 3) {
      case 0: return (HSI / 2) * mul;
      case 1: return (HSI / prediv) * mul;
      case 2: return (HSE / prediv) * mul;
      default: return (HSI48 / prediv) * mul;
    }
  }

  private updateClocks(): void {
    // Oscillators become ready as soon as they are switched on.
    this.cr = (this.cr & ~0x02020002) | (this.cr & 1 ? 2 : 0) | (this.cr & 0x10000 ? 0x20000 : 0) | (this.cr & 0x1000000 ? 0x2000000 : 0);
    this.cr2 = (this.cr2 & ~0x20002) | (this.cr2 & 1 ? 2 : 0) | (this.cr2 & 0x10000 ? 0x20000 : 0);

    const sw = this.cfgr & 3;
    let sws = (this.cfgr >> 2) & 3;
    const ready =
      sw === 0 ? (this.cr & 2) !== 0 : sw === 1 ? (this.cr & 0x20000) !== 0 : sw === 2 ? (this.cr & 0x2000000) !== 0 : (this.cr2 & 0x20000) !== 0;
    if (ready) sws = sw;
    else {
      this.hint(
        'rcc:sw',
        'The system clock switch (RCC_CFGR SW) selects an oscillator that is not switched on, so the clock did not change. ' +
          'Turn the source on and wait for its RDY flag first.',
      );
    }
    this.cfgr = (this.cfgr & ~0xc) | (sws << 2);
    const sysclk = sws === 0 ? HSI : sws === 1 ? HSE : sws === 2 ? this.pllOut() : HSI48;
    const hclk = sysclk / AHB_DIV[(this.cfgr >> 4) & 15];
    const pclk = hclk / APB_DIV[(this.cfgr >> 8) & 7];
    if (sysclk > 48_000_000) {
      this.hint('rcc:overclock', `The PLL is configured for ${(sysclk / 1e6).toFixed(0)} MHz, above the 48 MHz maximum of this chip.`);
    }
    if (sysclk > 24_000_000 && (this.flashLatency() & 1) === 0) {
      this.hint(
        'rcc:latency',
        'The system clock is above 24 MHz but FLASH->ACR has no wait state (LATENCY = 0). ' +
          'A real chip would read garbage from flash and crash. Set FLASH_ACR_LATENCY before speeding up.',
      );
    }
    const changed = sysclk !== this.sysclk || hclk !== this.hclk || pclk !== this.pclk;
    this.sysclk = sysclk;
    this.hclk = hclk;
    this.pclk = pclk;
    if (changed) {
      this.clock.setHz(hclk);
      for (const fn of this.listeners) fn();
    }
  }

  read32(off: number): number {
    switch (off) {
      case 0x00: return this.cr;
      case 0x04: return this.cfgr;
      case 0x08: return this.cir;
      case 0x14: return this.ahbenr;
      case 0x18: return this.apb2enr;
      case 0x1c: return this.apb1enr;
      case 0x20: return this.bdcr;
      case 0x24: return this.csr;
      case 0x2c: return this.cfgr2;
      case 0x30: return this.cfgr3;
      case 0x34: return this.cr2;
      default: return 0;
    }
  }

  write32(off: number, v: number): void {
    switch (off) {
      case 0x00:
        this.cr = (this.cr & 0x0202ff02) | (v & 0x010d00f9);
        this.updateClocks();
        break;
      case 0x04:
        this.cfgr = (this.cfgr & 0xc) | (v & ~0xc);
        this.updateClocks();
        break;
      case 0x08: this.cir = v & 0x00007f00; break;
      case 0x14: this.ahbenr = v; break;
      case 0x18: this.apb2enr = v; break;
      case 0x1c: this.apb1enr = v; break;
      case 0x20: this.bdcr = v; break;
      case 0x24:
        if (v & 0x01000000) this.csr &= 0x00ffffff; // RMVF clears the reset flags
        this.csr = (this.csr & ~1) | (v & 1);
        this.csr = (this.csr & ~2) | (this.csr & 1 ? 2 : 0);
        break;
      case 0x2c:
        this.cfgr2 = v & 15;
        this.updateClocks();
        break;
      case 0x30: this.cfgr3 = v; break;
      case 0x34:
        this.cr2 = (this.cr2 & 0xff02ff02) | (v & 0x000100fd);
        this.updateClocks();
        break;
    }
  }
}
