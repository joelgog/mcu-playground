/** The complete simulated STM32F072RB: CPU core, memory, peripherals and the pin nets. */
import { Net } from '../board/net';
import { Bus, FLASH_BASE, RAM_BASE, RAM_SIZE } from './bus';
import { Clock } from './clock';
import { Cpu, FaultInfo } from './cpu';
import { ElfImage, ElfSymbol, loadImage, parseElf, symbolAt } from './elf';
import { Adc } from './peripherals/adc';
import { Exti, Syscfg } from './peripherals/exti';
import { AfMux, GpioPort } from './peripherals/gpio';
import { FlashIf, Iwdg } from './peripherals/misc';
import { Rcc, ResetCause } from './peripherals/rcc';
import { Timer } from './peripherals/timer';
import { Usart } from './peripherals/usart';

export interface Hint {
  id: string;
  message: string;
  timeSec: number;
  pc: number;
}

const PORTS: Array<[string, number]> = [['A', 0], ['B', 1], ['C', 2], ['D', 3], ['F', 5]];

/** ADC channel -> pin name. */
export const ADC_PINS = ['PA0', 'PA1', 'PA2', 'PA3', 'PA4', 'PA5', 'PA6', 'PA7', 'PB0', 'PB1', 'PC0', 'PC1', 'PC2', 'PC3', 'PC4', 'PC5'];

export class Mcu {
  readonly clock = new Clock();
  readonly bus = new Bus();
  readonly cpu: Cpu;
  readonly rcc: Rcc;
  readonly afmux = new AfMux();
  readonly syscfg = new Syscfg();
  readonly exti: Exti;
  readonly ports = new Map<string, GpioPort>();
  readonly timers = new Map<string, Timer>();
  readonly adc: Adc;
  readonly usart2: Usart;
  readonly iwdg: Iwdg;
  readonly flashIf = new FlashIf();
  readonly nets = new Map<string, Net>();

  hints: Hint[] = [];
  onHint: (h: Hint) => void = () => {};
  onFault: (f: FaultInfo) => void = () => {};
  onReset: (cause: ResetCause) => void = () => {};
  image: ElfImage | null = null;
  resetCount = 0;
  lastResetCause: ResetCause = 'power';
  /** Die temperature reported by the internal temperature sensor. */
  chipTempC = 30;
  private pendingReset: ResetCause | null = null;
  private hintIds = new Set<string>();

  constructor() {
    const hint = this.hint;
    this.bus.hint = hint;
    this.cpu = new Cpu(this.bus, this.clock);
    this.cpu.hint = hint;
    this.cpu.onFault = (f) => this.onFault(f);
    this.cpu.onResetRequest = () => this.requestReset('software');

    this.rcc = new Rcc(this.clock, hint);
    this.rcc.flashLatency = () => this.flashIf.acr;
    this.bus.map(0x40021000, this.rcc);
    this.bus.map(0x40022000, this.flashIf);

    this.exti = new Exti(this.syscfg, (irq, level) => this.cpu.setIrqLine(irq, level));
    this.bus.map(0x40010000, this.syscfg, () => (this.rcc.apb2enr & 1) !== 0);
    this.bus.map(0x40010400, this.exti);

    for (const [letter, index] of PORTS) {
      const nets: Net[] = [];
      for (let pin = 0; pin < 16; pin++) {
        const net = new Net(`P${letter}${pin}`, this.clock);
        this.nets.set(net.name, net);
        nets.push(net);
      }
      const port = new GpioPort(letter, index, nets, this.afmux, this.exti, hint);
      this.ports.set(letter, port);
      this.bus.map(0x48000000 + index * 0x400, port, () => (this.rcc.ahbenr & (1 << (17 + index))) !== 0);
    }

    const timer = (name: string, base: number, bits: 16 | 32, nch: number, irq: number, enBit: number) => {
      const t = new Timer(name, bits, nch, {
        clock: this.clock,
        afmux: this.afmux,
        setIrq: (level) => this.cpu.setIrqLine(irq, level),
        clkDiv: () => this.rcc.timerClkDiv(),
        hint,
      });
      this.timers.set(name, t);
      this.bus.map(base, t, () => (this.rcc.apb1enr & (1 << enBit)) !== 0);
      this.rcc.onClockChange(() => t.clockChanged());
    };
    timer('TIM2', 0x40000000, 32, 4, 15, 0);
    timer('TIM3', 0x40000400, 16, 4, 16, 1);
    timer('TIM6', 0x40001000, 16, 0, 17, 4);
    timer('TIM7', 0x40001400, 16, 0, 18, 5);
    timer('TIM14', 0x40002000, 16, 1, 19, 8);

    this.adc = new Adc({
      clock: this.clock,
      setIrq: (level) => this.cpu.setIrqLine(12, level),
      pclkHz: () => this.rcc.pclk,
      chipTempC: () => this.chipTempC,
      hint,
      channelVolts: (ch) => {
        const name = ADC_PINS[ch];
        const port = this.ports.get(name[1])!;
        const pin = Number(name.slice(2));
        if (port.mode(pin) !== 3) {
          hint(
            `adc:mode:${name}`,
            `ADC channel ${ch} was converted, but ${name} is not in analog mode. Set its MODER bits to 11 so the digital input stage does not load the signal.`,
          );
        }
        return this.nets.get(name)!.v;
      },
    });
    this.bus.map(0x40012400, this.adc, () => (this.rcc.apb2enr & (1 << 9)) !== 0);

    this.usart2 = new Usart('USART2', {
      clock: this.clock,
      afmux: this.afmux,
      setIrq: (level) => this.cpu.setIrqLine(28, level),
      pclkHz: () => this.rcc.pclk,
      pclkDiv: () => this.rcc.pclkDiv(),
      hint,
    });
    this.bus.map(0x40004400, this.usart2, () => (this.rcc.apb1enr & (1 << 17)) !== 0);

    this.iwdg = new Iwdg(this.clock, () => this.requestReset('iwdg'), hint);
    this.bus.map(0x40003000, this.iwdg);

    this.resetPeripherals('power');
  }

  private hint = (id: string, message: string): void => {
    if (this.hintIds.has(id)) return;
    this.hintIds.add(id);
    const h: Hint = { id, message, timeSec: this.clock.seconds(), pc: this.cpu ? this.cpu.instrAddr >>> 0 : 0 };
    this.hints.push(h);
    this.onHint(h);
  };

  /** Emit a hint from a board device or checker. */
  addHint(id: string, message: string): void {
    this.hint(id, message);
  }

  net(name: string): Net {
    const n = this.nets.get(name);
    if (!n) throw new Error(`No such pin: ${name}`);
    return n;
  }

  /** Load a firmware image into flash and perform a power-on reset. */
  load(elf: Uint8Array): ElfImage {
    const image = parseElf(elf);
    if (!loadImage(image, this.bus.flash, FLASH_BASE, this.bus.ram, RAM_BASE)) {
      throw new Error('The program does not fit into the 128 KiB of flash.');
    }
    this.image = image;
    this.hints = [];
    this.hintIds.clear();
    this.reset('power');
    return image;
  }

  private resetPeripherals(cause: ResetCause): void {
    this.rcc.reset(cause);
    this.flashIf.reset();
    this.afmux.reset();
    this.syscfg.reset();
    this.exti.reset();
    for (const t of this.timers.values()) t.reset();
    this.adc.reset();
    this.usart2.reset();
    this.iwdg.reset();
    for (const p of this.ports.values()) p.reset();
  }

  reset(cause: ResetCause = 'pin'): void {
    this.pendingReset = null;
    if (cause === 'power') this.bus.resetMemory();
    this.resetPeripherals(cause);
    this.cpu.reset();
    this.resetCount++;
    this.lastResetCause = cause;
    this.onReset(cause);
  }

  /** Reset requested from inside the simulation (watchdog, SYSRESETREQ); applied between instructions. */
  private requestReset(cause: ResetCause): void {
    this.pendingReset = cause;
    this.cpu.stopRequested = true;
  }

  /** Run for a number of CPU cycles. Returns early if the CPU halts or a stop was requested. */
  run(cycles: number): void {
    const end = this.clock.cycles + cycles;
    while (this.clock.cycles < end) {
      this.cpu.run(end - this.clock.cycles);
      if (this.pendingReset) {
        this.reset(this.pendingReset);
        continue;
      }
      break;
    }
  }

  /** Run for a span of simulated time (follows clock-speed changes made by the program). */
  runSeconds(sec: number): void {
    const target = this.clock.seconds() + sec;
    while (!this.cpu.halted) {
      const remaining = target - this.clock.seconds();
      if (remaining <= 1e-12) break;
      this.run(Math.max(1, Math.ceil(remaining * this.clock.hz)));
      if (this.cpu.stopRequested) break;
    }
  }

  // ------------------------------------------------------------- symbols

  symbol(name: string): ElfSymbol | null {
    return this.image?.symbols.find((s) => s.name === name) ?? null;
  }

  functionAt(addr: number): string | null {
    return this.image ? (symbolAt(this.image, addr)?.name ?? null) : null;
  }

  /** Read a global variable by name (1, 2 or 4 bytes, little endian). */
  readGlobal(name: string, size = 4): number | null {
    const s = this.symbol(name);
    if (!s) return null;
    const off = s.addr - RAM_BASE;
    if (off < 0 || off + size > RAM_SIZE) return null;
    let v = 0;
    for (let i = size - 1; i >= 0; i--) v = v * 256 + this.bus.ram[off + i];
    return v;
  }

  /** Lowest stack pointer still considered safe: the end of .bss/heap start. */
  stackLimit(): number {
    return this.symbol('_end')?.addr ?? this.symbol('_ebss')?.addr ?? RAM_BASE;
  }
}
