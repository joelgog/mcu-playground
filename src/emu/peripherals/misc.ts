/** Small peripherals: independent watchdog and the flash interface register block. */
import { HintFn, Peripheral } from '../bus';
import { Clock, SimEvent } from '../clock';

const LSI_HZ = 40_000;

export class Iwdg implements Peripheral {
  readonly name = 'IWDG';
  pr = 0;
  rlr = 0xfff;
  running = false;
  private unlocked = false;
  private ev: SimEvent | null = null;

  constructor(
    private clock: Clock,
    private onTimeout: () => void,
    private hint: HintFn,
  ) {}

  reset(): void {
    this.clock.cancel(this.ev);
    this.ev = null;
    this.pr = 0;
    this.rlr = 0xfff;
    this.running = false;
    this.unlocked = false;
  }

  /** Watchdog timeout in seconds for the current prescaler and reload value. */
  timeoutSec(): number {
    return ((4 << Math.min(this.pr, 6)) * (this.rlr + 1)) / LSI_HZ;
  }

  private restart(): void {
    this.clock.cancel(this.ev);
    this.ev = this.clock.scheduleSec(this.timeoutSec(), () => {
      this.ev = null;
      this.onTimeout();
    });
  }

  read32(off: number): number {
    switch (off) {
      case 0x04: return this.pr;
      case 0x08: return this.rlr;
      case 0x10: return 0xfff;
      default: return 0;
    }
  }

  write32(off: number, value: number): void {
    const v = value & 0xffff;
    switch (off) {
      case 0x00:
        if (v === 0xcccc) {
          this.running = true;
          this.unlocked = false;
          this.restart();
        } else if (v === 0xaaaa) {
          this.unlocked = false;
          if (this.running) this.restart();
        } else {
          this.unlocked = v === 0x5555;
        }
        break;
      case 0x04:
      case 0x08:
        if (!this.unlocked) {
          this.hint('iwdg:locked', 'IWDG->PR / RLR are write-protected. Write 0x5555 to IWDG->KR first to unlock them.');
        } else if (off === 0x04) this.pr = v & 7;
        else this.rlr = v & 0xfff;
        break;
    }
  }
}

export class FlashIf implements Peripheral {
  readonly name = 'FLASH';
  acr = 0;

  reset(): void {
    this.acr = 0;
  }

  read32(off: number): number {
    if (off === 0x00) return this.acr | 0x20; // prefetch buffer status
    if (off === 0x10) return 0x80; // CR: locked
    return 0;
  }

  write32(off: number, value: number): void {
    if (off === 0x00) this.acr = value & 0x11;
  }
}
