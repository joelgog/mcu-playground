/**
 * ARMv6-M (Cortex-M0) CPU core: Thumb instruction set, exceptions, NVIC, SysTick.
 *
 * Cycle counts follow the Cortex-M0 technical reference manual so that simulated
 * time (cycles / HCLK) matches what the code would take on a real STM32F0.
 */
import { Bus, CpuFault, SystemControlSpace } from './bus';
import { Clock, SimEvent } from './clock';

export const EXC_NMI = 2;
export const EXC_HARDFAULT = 3;
export const EXC_SVC = 11;
export const EXC_PENDSV = 14;
export const EXC_SYSTICK = 15;
export const EXC_IRQ0 = 16;
const NUM_EXC = 48;

export interface FaultInfo {
  kind: string;
  /** Address of the instruction that faulted. */
  pc: number;
  /** Data or branch address involved, if any. */
  addr: number;
  message: string;
  lr: number;
  sp: number;
  /** True if the CPU could not even enter the HardFault handler and has stopped. */
  lockup: boolean;
}

export type HaltReason = 'lockup' | 'breakpoint' | 'exit' | null;

export class Cpu implements SystemControlSpace {
  readonly r = new Int32Array(16);
  n = 0;
  z = 0;
  c = 0;
  v = 0;
  ipsr = 0;
  primask = 0;
  /** CONTROL register: bit 1 = SPSEL (thread mode uses PSP). */
  control = 0;
  /** The stack pointer that is not currently in r[13]. */
  private spOther = 0;
  /** Address of the next instruction to execute. */
  pc = 0;
  /** Address of the instruction currently executing. */
  instrAddr = 0;

  sleeping = false;
  halted: HaltReason = null;
  /** Set (e.g. from a fault or hint callback) to make run() return early. */
  stopRequested = false;
  /** Total cycles spent asleep in WFI (for low-power statistics). */
  sleepCycles = 0;
  lastFault: FaultInfo | null = null;
  onFault: (f: FaultInfo) => void = () => {};
  onResetRequest: () => void = () => {};
  hint: (id: string, message: string) => void = () => {};

  private readonly pending = new Uint8Array(NUM_EXC);
  private readonly enabled = new Uint8Array(NUM_EXC);
  private readonly active = new Uint8Array(NUM_EXC);
  private readonly prio = new Int16Array(NUM_EXC);
  private readonly irqLine = new Uint8Array(32);
  private irqCheck = false;
  private lastReturnExc = 0;
  private lastReturnAt = -1;
  private stormCount = 0;

  // SysTick
  private stCtrl = 0;
  private stLoad = 0;
  private stVal = 0;
  private stFlag = 0;
  private stWrapAt = 0;
  private stEvent: SimEvent | null = null;

  constructor(
    readonly bus: Bus,
    readonly clock: Clock,
  ) {
    bus.scs = this;
    this.resetState();
  }

  // ------------------------------------------------------------------ reset

  private resetState(): void {
    this.r.fill(0);
    this.n = this.z = this.c = this.v = 0;
    this.ipsr = 0;
    this.primask = 0;
    this.control = 0;
    this.spOther = 0;
    this.sleeping = false;
    this.halted = null;
    this.lastFault = null;
    this.pending.fill(0);
    this.active.fill(0);
    this.enabled.fill(0);
    this.prio.fill(0);
    this.irqLine.fill(0);
    for (let e = 0; e < EXC_IRQ0; e++) this.enabled[e] = 1;
    this.prio[EXC_NMI] = -2;
    this.prio[EXC_HARDFAULT] = -1;
    this.irqCheck = false;
    this.stormCount = 0;
    this.lastReturnAt = -1;
    this.clock.cancel(this.stEvent);
    this.stEvent = null;
    this.stCtrl = 0;
    this.stLoad = 0;
    this.stVal = 0;
    this.stFlag = 0;
  }

  /** Reset the core and load SP and PC from the vector table. */
  reset(): void {
    this.resetState();
    this.r[13] = this.bus.read32(0) & ~3;
    const entry = this.bus.read32(4);
    this.pc = entry & ~1;
    this.r[14] = -1;
    if (!(entry & 1) || entry === -1) {
      this.halted = 'lockup';
      this.lastFault = {
        kind: 'vector', pc: 0, addr: entry >>> 0, lr: 0, sp: this.r[13] >>> 0, lockup: true,
        message: 'The reset vector is empty or invalid, so there is no program to run.',
      };
    }
  }

  // ------------------------------------------------------------- interrupts

  /** Level of an external interrupt line (IRQ number 0..31) driven by a peripheral. */
  setIrqLine(irq: number, level: boolean): void {
    const l = level ? 1 : 0;
    if (this.irqLine[irq] === l) return;
    this.irqLine[irq] = l;
    if (l) {
      this.pending[EXC_IRQ0 + irq] = 1;
      this.irqCheck = true;
    }
  }

  pendException(exc: number): void {
    this.pending[exc] = 1;
    this.irqCheck = true;
  }

  private currentPriority(): number {
    let cur = 256;
    const active = this.active;
    for (let e = 2; e < NUM_EXC; e++) if (active[e] && this.prio[e] < cur) cur = this.prio[e];
    return cur;
  }

  private checkInterrupts(): void {
    this.irqCheck = false;
    let best = -1;
    let bestPrio = 256;
    const pending = this.pending;
    for (let e = 2; e < NUM_EXC; e++) {
      if (pending[e] && this.enabled[e] && this.prio[e] < bestPrio) {
        bestPrio = this.prio[e];
        best = e;
      }
    }
    if (best < 0) return;
    const cur = this.currentPriority();
    if (bestPrio >= cur) return;
    // WFI wakes on any interrupt that could be taken, even while PRIMASK masks it.
    this.sleeping = false;
    if (this.primask && bestPrio >= 0) return;
    if (best === this.lastReturnExc && this.clock.cycles === this.lastReturnAt) {
      if (++this.stormCount === 2000) {
        const name = best >= EXC_IRQ0 ? `IRQ ${best - EXC_IRQ0}` : `exception ${best}`;
        this.hint(
          `storm:${best}`,
          `The handler for ${name} is re-entered immediately every time it returns, so main() never runs. ` +
            `The interrupt flag is probably not being cleared inside the handler.`,
        );
      }
    } else {
      this.stormCount = 0;
    }
    this.enterException(best, this.pc);
  }

  private xpsr(): number {
    return (this.n << 31) | (this.z << 30) | (this.c << 29) | (this.v << 28) | 0x01000000 | this.ipsr;
  }

  private enterException(exc: number, returnAddr: number): void {
    const r = this.r;
    const bus = this.bus;
    const sp0 = r[13] >>> 0;
    const align = (sp0 >>> 2) & 1;
    const frame = ((sp0 - 0x20) & ~4) >>> 0;
    bus.write32(frame, r[0]);
    bus.write32(frame + 4, r[1]);
    bus.write32(frame + 8, r[2]);
    bus.write32(frame + 12, r[3]);
    bus.write32(frame + 16, r[12]);
    bus.write32(frame + 20, r[14]);
    bus.write32(frame + 24, returnAddr);
    bus.write32(frame + 28, this.xpsr() | (align << 9));
    r[13] = frame;
    if (this.ipsr !== 0) r[14] = 0xfffffff1 | 0;
    else if (this.control & 2) r[14] = 0xfffffffd | 0;
    else r[14] = 0xfffffff9 | 0;
    if (this.control & 2) {
      const t = r[13];
      r[13] = this.spOther;
      this.spOther = t;
      this.control &= ~2;
    }
    this.ipsr = exc;
    this.active[exc] = 1;
    this.pending[exc] = 0;
    const vec = bus.read32(exc * 4);
    if (!(vec & 1)) {
      throw new CpuFault('vector', vec >>> 0, `The vector table entry for exception ${exc} is not a valid handler address.`);
    }
    this.pc = vec & ~1;
    this.sleeping = false;
    this.clock.cycles += 16;
    this.irqCheck = true;
  }

  private exceptionReturn(excReturn: number): void {
    const r = this.r;
    const bus = this.bus;
    const exc = this.ipsr;
    const mode = excReturn & 0xf;
    if (mode !== 1 && mode !== 9 && mode !== 0xd) {
      throw new CpuFault('excreturn', excReturn >>> 0, 'Invalid EXC_RETURN value in LR when returning from an interrupt handler.');
    }
    this.active[exc] = 0;
    if (mode === 0xd) {
      const t = r[13];
      r[13] = this.spOther;
      this.spOther = t;
      this.control |= 2;
    }
    const frame = r[13] >>> 0;
    r[0] = bus.read32(frame);
    r[1] = bus.read32(frame + 4);
    r[2] = bus.read32(frame + 8);
    r[3] = bus.read32(frame + 12);
    r[12] = bus.read32(frame + 16);
    r[14] = bus.read32(frame + 20);
    this.pc = bus.read32(frame + 24) & ~1;
    const psr = bus.read32(frame + 28);
    r[13] = (frame + 0x20) | (((psr >>> 9) & 1) << 2);
    this.n = psr >>> 31;
    this.z = (psr >>> 30) & 1;
    this.c = (psr >>> 29) & 1;
    this.v = (psr >>> 28) & 1;
    this.ipsr = psr & 0x3f;
    if ((mode === 1) !== (this.ipsr !== 0)) {
      throw new CpuFault('excreturn', excReturn >>> 0, 'Corrupted stack frame when returning from an interrupt handler (stack overwritten?).');
    }
    // Level-sensitive interrupt lines pend again if the peripheral still requests service.
    if (exc >= EXC_IRQ0 && this.irqLine[exc - EXC_IRQ0]) this.pending[exc] = 1;
    this.clock.cycles += 12;
    this.lastReturnExc = exc;
    this.lastReturnAt = this.clock.cycles;
    this.irqCheck = true;
  }

  private raiseFault(f: CpuFault): void {
    const info: FaultInfo = {
      kind: f.kind,
      pc: this.instrAddr >>> 0,
      addr: f.addr >>> 0,
      message: f.message,
      lr: this.r[14] >>> 0,
      sp: this.r[13] >>> 0,
      lockup: false,
    };
    if (this.ipsr === EXC_HARDFAULT || this.ipsr === EXC_NMI) {
      info.lockup = true;
      info.message += ' This happened inside the HardFault handler, so the CPU locked up.';
    } else {
      try {
        this.enterException(EXC_HARDFAULT, this.instrAddr);
      } catch (e) {
        if (!(e instanceof CpuFault)) throw e;
        info.lockup = true;
        info.message += ' The CPU could not even enter the HardFault handler (invalid stack pointer), so it locked up.';
      }
    }
    if (info.lockup) this.halted = 'lockup';
    this.lastFault = info;
    this.onFault(info);
  }

  // ------------------------------------------------------------------ run

  /** Execute for (at least) the given number of cycles, running due events. */
  run(maxCycles: number): void {
    const clock = this.clock;
    const end = clock.cycles + maxCycles;
    this.stopRequested = false;
    while (clock.cycles < end && this.halted === null && !this.stopRequested) {
      if (clock.cycles >= clock.nextEventAt) clock.runDue();
      if (this.irqCheck) {
        try {
          this.checkInterrupts();
        } catch (e) {
          if (e instanceof CpuFault) this.raiseFault(e);
          else throw e;
        }
      }
      if (this.sleeping) {
        const t = Math.min(clock.nextEventAt, end);
        this.sleepCycles += t - clock.cycles;
        clock.cycles = t;
        continue;
      }
      try {
        this.step();
      } catch (e) {
        if (e instanceof CpuFault) this.raiseFault(e);
        else throw e;
      }
    }
  }

  private addc(a: number, b: number, carry: number): number {
    const sum = (a >>> 0) + (b >>> 0) + carry;
    const res = sum | 0;
    this.n = res >>> 31;
    this.z = res === 0 ? 1 : 0;
    this.c = sum > 0xffffffff ? 1 : 0;
    this.v = ((a ^ res) & (b ^ res)) >>> 31;
    return res;
  }

  private undefined(instr: number): never {
    throw new CpuFault(
      'undefined',
      this.instrAddr >>> 0,
      `Undefined instruction 0x${instr.toString(16)}. The CPU ran into data or garbage instead of code ` +
        `(corrupted return address or function pointer?).`,
    );
  }

  private bxWritePC(target: number): void {
    if (this.ipsr !== 0 && target >>> 28 === 0xf) {
      this.exceptionReturn(target);
      return;
    }
    if (!(target & 1)) {
      throw new CpuFault(
        'invstate',
        target >>> 0,
        `Branch to 0x${(target >>> 0).toString(16)}, which is not a valid Thumb code address ` +
          `(NULL or corrupted function pointer / return address?).`,
      );
    }
    this.pc = target & ~1;
  }

  /** Execute one instruction. */
  step(): void {
    const r = this.r;
    const bus = this.bus;
    const ia = this.pc;
    this.instrAddr = ia;
    const instr = bus.fetch16(ia);
    this.pc = ia + 2;
    let cyc = 1;

    switch (instr >>> 11) {
      case 0: { // LSLS Rd, Rm, #imm5  (imm 0 = MOVS Rd, Rm)
        const imm = (instr >> 6) & 31;
        let val = r[(instr >> 3) & 7];
        if (imm) {
          this.c = (val >>> (32 - imm)) & 1;
          val <<= imm;
        }
        r[instr & 7] = val;
        this.n = val >>> 31;
        this.z = val === 0 ? 1 : 0;
        break;
      }
      case 1: { // LSRS Rd, Rm, #imm5
        const imm = (instr >> 6) & 31;
        let val = r[(instr >> 3) & 7];
        if (imm === 0) {
          this.c = val >>> 31;
          val = 0;
        } else {
          this.c = (val >>> (imm - 1)) & 1;
          val >>>= imm;
        }
        r[instr & 7] = val;
        this.n = 0;
        this.z = val === 0 ? 1 : 0;
        break;
      }
      case 2: { // ASRS Rd, Rm, #imm5
        const imm = (instr >> 6) & 31;
        let val = r[(instr >> 3) & 7];
        if (imm === 0) {
          this.c = val >>> 31;
          val >>= 31;
        } else {
          this.c = (val >> (imm - 1)) & 1;
          val >>= imm;
        }
        r[instr & 7] = val;
        this.n = val >>> 31;
        this.z = val === 0 ? 1 : 0;
        break;
      }
      case 3: { // ADDS / SUBS (register or 3-bit immediate)
        const x = (instr >> 6) & 7;
        const a = r[(instr >> 3) & 7];
        const b = instr & 0x400 ? x : r[x];
        r[instr & 7] = instr & 0x200 ? this.addc(a, ~b, 1) : this.addc(a, b, 0);
        break;
      }
      case 4: { // MOVS Rd, #imm8
        const imm = instr & 0xff;
        r[(instr >> 8) & 7] = imm;
        this.n = 0;
        this.z = imm === 0 ? 1 : 0;
        break;
      }
      case 5: // CMP Rn, #imm8
        this.addc(r[(instr >> 8) & 7], ~(instr & 0xff), 1);
        break;
      case 6: { // ADDS Rdn, #imm8
        const rd = (instr >> 8) & 7;
        r[rd] = this.addc(r[rd], instr & 0xff, 0);
        break;
      }
      case 7: { // SUBS Rdn, #imm8
        const rd = (instr >> 8) & 7;
        r[rd] = this.addc(r[rd], ~(instr & 0xff), 1);
        break;
      }
      case 8: {
        if (!(instr & 0x400)) {
          // Data processing on low registers
          const rdn = instr & 7;
          const a = r[rdn];
          const b = r[(instr >> 3) & 7];
          let res: number;
          switch ((instr >> 6) & 15) {
            case 0: res = a & b; r[rdn] = res; break; // ANDS
            case 1: res = a ^ b; r[rdn] = res; break; // EORS
            case 2: { // LSLS (register)
              const s = b & 0xff;
              res = a;
              if (s) {
                if (s < 32) { this.c = (a >>> (32 - s)) & 1; res = a << s; }
                else { this.c = s === 32 ? a & 1 : 0; res = 0; }
              }
              r[rdn] = res;
              break;
            }
            case 3: { // LSRS (register)
              const s = b & 0xff;
              res = a;
              if (s) {
                if (s < 32) { this.c = (a >>> (s - 1)) & 1; res = a >>> s; }
                else { this.c = s === 32 ? a >>> 31 : 0; res = 0; }
              }
              r[rdn] = res;
              res |= 0;
              break;
            }
            case 4: { // ASRS (register)
              const s = b & 0xff;
              res = a;
              if (s) {
                if (s < 32) { this.c = (a >> (s - 1)) & 1; res = a >> s; }
                else { this.c = a >>> 31; res = a >> 31; }
              }
              r[rdn] = res;
              break;
            }
            case 5: r[rdn] = this.addc(a, b, this.c); cyc = 1; this.clock.cycles += cyc; return; // ADCS
            case 6: r[rdn] = this.addc(a, ~b, this.c); this.clock.cycles += cyc; return; // SBCS
            case 7: { // RORS
              const s = b & 0xff;
              res = a;
              if (s) {
                const k = s & 31;
                if (k) res = (a >>> k) | (a << (32 - k));
                this.c = res >>> 31;
              }
              r[rdn] = res;
              break;
            }
            case 8: res = a & b; break; // TST
            case 9: r[rdn] = this.addc(~b, 0, 1); this.clock.cycles += cyc; return; // RSBS Rd, Rn, #0
            case 10: this.addc(a, ~b, 1); this.clock.cycles += cyc; return; // CMP
            case 11: this.addc(a, b, 0); this.clock.cycles += cyc; return; // CMN
            case 12: res = a | b; r[rdn] = res; break; // ORRS
            case 13: res = Math.imul(a, b); r[rdn] = res; break; // MULS
            case 14: res = a & ~b; r[rdn] = res; break; // BICS
            default: res = ~b; r[rdn] = res; break; // MVNS
          }
          this.n = res >>> 31;
          this.z = res === 0 ? 1 : 0;
        } else {
          // Special data instructions and branch-exchange (high registers)
          const rm = (instr >> 3) & 15;
          const rd = ((instr >> 4) & 8) | (instr & 7);
          const vm = rm === 15 ? ia + 4 : r[rm];
          switch ((instr >> 8) & 3) {
            case 0: { // ADD Rdn, Rm
              const res = ((rd === 15 ? ia + 4 : r[rd]) + vm) | 0;
              if (rd === 15) { this.pc = res & ~1; cyc = 3; }
              else if (rd === 13) r[13] = res & ~3;
              else r[rd] = res;
              break;
            }
            case 1: // CMP Rn, Rm
              this.addc(rd === 15 ? ia + 4 : r[rd], ~vm, 1);
              break;
            case 2: // MOV Rd, Rm
              if (rd === 15) { this.pc = vm & ~1; cyc = 3; }
              else if (rd === 13) r[13] = vm & ~3;
              else r[rd] = vm;
              break;
            default: // BX / BLX
              if (instr & 0x80) r[14] = this.pc | 1;
              cyc = 3;
              this.clock.cycles += cyc;
              this.bxWritePC(vm);
              return;
          }
        }
        break;
      }
      case 9: // LDR Rt, [PC, #imm8]
        r[(instr >> 8) & 7] = bus.read32(((ia + 4) & ~3) + ((instr & 0xff) << 2));
        cyc = 2;
        break;
      case 10:
      case 11: { // Load/store with register offset
        const addr = (r[(instr >> 3) & 7] + r[(instr >> 6) & 7]) | 0;
        const rt = instr & 7;
        cyc = 2;
        switch ((instr >> 9) & 7) {
          case 0: bus.write32(addr, r[rt]); break;
          case 1: bus.write16(addr, r[rt] & 0xffff); break;
          case 2: bus.write8(addr, r[rt] & 0xff); break;
          case 3: r[rt] = (bus.read8(addr) << 24) >> 24; break;
          case 4: r[rt] = bus.read32(addr); break;
          case 5: r[rt] = bus.read16(addr); break;
          case 6: r[rt] = bus.read8(addr); break;
          default: r[rt] = (bus.read16(addr) << 16) >> 16; break;
        }
        break;
      }
      case 12: // STR Rt, [Rn, #imm5*4]
        bus.write32(r[(instr >> 3) & 7] + (((instr >> 6) & 31) << 2), r[instr & 7]);
        cyc = 2;
        break;
      case 13: // LDR Rt, [Rn, #imm5*4]
        r[instr & 7] = bus.read32(r[(instr >> 3) & 7] + (((instr >> 6) & 31) << 2));
        cyc = 2;
        break;
      case 14: // STRB
        bus.write8(r[(instr >> 3) & 7] + ((instr >> 6) & 31), r[instr & 7] & 0xff);
        cyc = 2;
        break;
      case 15: // LDRB
        r[instr & 7] = bus.read8(r[(instr >> 3) & 7] + ((instr >> 6) & 31));
        cyc = 2;
        break;
      case 16: // STRH
        bus.write16(r[(instr >> 3) & 7] + (((instr >> 6) & 31) << 1), r[instr & 7] & 0xffff);
        cyc = 2;
        break;
      case 17: // LDRH
        r[instr & 7] = bus.read16(r[(instr >> 3) & 7] + (((instr >> 6) & 31) << 1));
        cyc = 2;
        break;
      case 18: // STR Rt, [SP, #imm8*4]
        bus.write32(r[13] + ((instr & 0xff) << 2), r[(instr >> 8) & 7]);
        cyc = 2;
        break;
      case 19: // LDR Rt, [SP, #imm8*4]
        r[(instr >> 8) & 7] = bus.read32(r[13] + ((instr & 0xff) << 2));
        cyc = 2;
        break;
      case 20: // ADR Rd, label
        r[(instr >> 8) & 7] = ((ia + 4) & ~3) + ((instr & 0xff) << 2);
        break;
      case 21: // ADD Rd, SP, #imm8*4
        r[(instr >> 8) & 7] = r[13] + ((instr & 0xff) << 2);
        break;
      case 22: {
        switch ((instr >> 8) & 7) {
          case 0: { // ADD/SUB SP, #imm7*4
            const imm = (instr & 0x7f) << 2;
            r[13] = instr & 0x80 ? r[13] - imm : r[13] + imm;
            break;
          }
          case 2: { // SXTH, SXTB, UXTH, UXTB
            const val = r[(instr >> 3) & 7];
            const rd = instr & 7;
            switch ((instr >> 6) & 3) {
              case 0: r[rd] = (val << 16) >> 16; break;
              case 1: r[rd] = (val << 24) >> 24; break;
              case 2: r[rd] = val & 0xffff; break;
              default: r[rd] = val & 0xff; break;
            }
            break;
          }
          case 4:
          case 5: { // PUSH {list[, lr]}
            let count = 0;
            for (let m = instr & 0x1ff; m; m &= m - 1) count++;
            let addr = (r[13] - 4 * count) | 0;
            const newSp = addr;
            for (let i = 0; i < 8; i++) {
              if (instr & (1 << i)) { bus.write32(addr, r[i]); addr += 4; }
            }
            if (instr & 0x100) bus.write32(addr, r[14]);
            r[13] = newSp;
            cyc = 1 + count;
            break;
          }
          case 6: // CPSIE i / CPSID i
            if ((instr & 0xffef) !== 0xb662) this.undefined(instr);
            this.primask = (instr >> 4) & 1;
            this.irqCheck = true;
            break;
          default:
            this.undefined(instr);
        }
        break;
      }
      case 23: {
        switch ((instr >> 8) & 7) {
          case 2: { // REV, REV16, REVSH
            const val = r[(instr >> 3) & 7];
            const rd = instr & 7;
            switch ((instr >> 6) & 3) {
              case 0:
                r[rd] = (val << 24) | ((val & 0xff00) << 8) | ((val >>> 8) & 0xff00) | (val >>> 24);
                break;
              case 1:
                r[rd] = ((val & 0x00ff00ff) << 8) | ((val >>> 8) & 0x00ff00ff);
                break;
              case 3:
                r[rd] = (((val & 0xff) << 24) >> 16) | ((val >>> 8) & 0xff);
                break;
              default:
                this.undefined(instr);
            }
            break;
          }
          case 4:
          case 5: { // POP {list[, pc]}
            let addr = r[13];
            let count = 0;
            for (let i = 0; i < 8; i++) {
              if (instr & (1 << i)) { r[i] = bus.read32(addr); addr += 4; count++; }
            }
            if (instr & 0x100) {
              const target = bus.read32(addr);
              r[13] = addr + 4;
              this.clock.cycles += 4 + count;
              this.bxWritePC(target);
              return;
            }
            r[13] = addr;
            cyc = 1 + count;
            break;
          }
          case 6: // BKPT (0xFE is used by the startup code to signal "main returned")
            this.halted = (instr & 0xff) === 0xfe ? 'exit' : 'breakpoint';
            break;
          case 7: // Hints
            if (instr & 0xf) this.undefined(instr);
            if (((instr >> 4) & 15) === 3) { // WFI
              this.sleeping = true;
              this.irqCheck = true;
              cyc = 2;
            }
            break;
          default:
            this.undefined(instr);
        }
        break;
      }
      case 24: { // STMIA Rn!, {list}
        const rn = (instr >> 8) & 7;
        let addr = r[rn];
        let count = 0;
        for (let i = 0; i < 8; i++) {
          if (instr & (1 << i)) { bus.write32(addr, r[i]); addr += 4; count++; }
        }
        r[rn] = addr;
        cyc = 1 + count;
        break;
      }
      case 25: { // LDMIA Rn(!), {list}
        const rn = (instr >> 8) & 7;
        let addr = r[rn];
        let count = 0;
        for (let i = 0; i < 8; i++) {
          if (instr & (1 << i)) { r[i] = bus.read32(addr); addr += 4; count++; }
        }
        if (!(instr & (1 << rn))) r[rn] = addr;
        cyc = 1 + count;
        break;
      }
      case 26:
      case 27: { // B<cond>, UDF, SVC
        const cond = (instr >> 8) & 15;
        let take: boolean;
        switch (cond) {
          case 0: take = this.z === 1; break;
          case 1: take = this.z === 0; break;
          case 2: take = this.c === 1; break;
          case 3: take = this.c === 0; break;
          case 4: take = this.n === 1; break;
          case 5: take = this.n === 0; break;
          case 6: take = this.v === 1; break;
          case 7: take = this.v === 0; break;
          case 8: take = this.c === 1 && this.z === 0; break;
          case 9: take = this.c === 0 || this.z === 1; break;
          case 10: take = this.n === this.v; break;
          case 11: take = this.n !== this.v; break;
          case 12: take = this.z === 0 && this.n === this.v; break;
          case 13: take = this.z === 1 || this.n !== this.v; break;
          case 14:
            this.undefined(instr);
          // eslint-disable-next-line no-fallthrough
          default: { // SVC
            if (this.primask || this.prio[EXC_SVC] >= this.currentPriority()) {
              throw new CpuFault('svc', ia >>> 0, 'SVC was executed while interrupts are masked or inside a handler of equal or higher priority.');
            }
            this.pending[EXC_SVC] = 1;
            this.irqCheck = true;
            this.clock.cycles += 1;
            return;
          }
        }
        if (take) {
          this.pc = ia + 4 + ((instr << 24) >> 23);
          cyc = 3;
        }
        break;
      }
      case 28: // B label
        this.pc = ia + 4 + ((instr << 21) >> 20);
        cyc = 3;
        break;
      case 30: { // 32-bit instructions: BL, MSR, MRS, barriers
        const hw2 = bus.fetch16(ia + 2);
        this.pc = ia + 4;
        if ((hw2 & 0xd000) === 0xd000) {
          const s = (instr >> 10) & 1;
          const i1 = 1 ^ (((hw2 >> 13) & 1) ^ s);
          const i2 = 1 ^ (((hw2 >> 11) & 1) ^ s);
          const imm = (s << 24) | (i1 << 23) | (i2 << 22) | ((instr & 0x3ff) << 12) | ((hw2 & 0x7ff) << 1);
          r[14] = (ia + 4) | 1;
          this.pc = ia + 4 + ((imm << 7) >> 7);
          cyc = 4;
        } else if ((instr & 0xfff0) === 0xf380 && (hw2 & 0xff00) === 0x8800) {
          this.msr(hw2 & 0xff, r[instr & 15]);
          cyc = 4;
        } else if (instr === 0xf3ef && (hw2 & 0xf000) === 0x8000) {
          r[(hw2 >> 8) & 15] = this.mrs(hw2 & 0xff);
          cyc = 4;
        } else if (instr === 0xf3bf && (hw2 & 0xff00) === 0x8f00) {
          cyc = 4; // DSB, DMB, ISB
        } else {
          this.undefined((instr << 16) | hw2);
        }
        break;
      }
      default:
        this.undefined(instr);
    }
    this.clock.cycles += cyc;
  }

  private mrs(sysm: number): number {
    switch (sysm >> 3) {
      case 0: {
        let val = 0;
        if (sysm & 1) val |= this.ipsr;
        if (!(sysm & 4)) val |= (this.n << 31) | (this.z << 30) | (this.c << 29) | (this.v << 28);
        return val;
      }
      case 1:
        if (sysm === 8) return this.control & 2 ? this.spOther : this.r[13];
        if (sysm === 9) return this.control & 2 ? this.r[13] : this.spOther;
        return 0;
      case 2:
        if (sysm === 16) return this.primask;
        if (sysm === 20) return this.control;
        return 0;
      default:
        return 0;
    }
  }

  private msr(sysm: number, val: number): void {
    switch (sysm >> 3) {
      case 0:
        if (!(sysm & 4)) {
          this.n = val >>> 31;
          this.z = (val >>> 30) & 1;
          this.c = (val >>> 29) & 1;
          this.v = (val >>> 28) & 1;
        }
        break;
      case 1:
        if (sysm === 8) {
          if (this.control & 2) this.spOther = val & ~3;
          else this.r[13] = val & ~3;
        } else if (sysm === 9) {
          if (this.control & 2) this.r[13] = val & ~3;
          else this.spOther = val & ~3;
        }
        break;
      case 2:
        if (sysm === 16) {
          this.primask = val & 1;
          this.irqCheck = true;
        } else if (sysm === 20 && this.ipsr === 0) {
          const spsel = val & 2;
          if (spsel !== (this.control & 2)) {
            const t = this.r[13];
            this.r[13] = this.spOther;
            this.spOther = t;
          }
          this.control = val & 3;
        }
        break;
    }
  }

  // ------------------------------------------- system control space (PPB)

  private stDiv(): number {
    return this.stCtrl & 4 ? 1 : 8;
  }

  private stCurrent(): number {
    if (!(this.stCtrl & 1)) return this.stVal;
    if (this.stEvent === null) return 0;
    const d = Math.ceil((this.stWrapAt - this.clock.time()) / this.stDiv());
    return d === this.stLoad + 1 ? 0 : Math.max(0, d);
  }

  private stStart(ticks: number): void {
    this.clock.cancel(this.stEvent);
    this.stEvent = null;
    if (ticks <= 0) return;
    this.stWrapAt = this.clock.time() + ticks * this.stDiv();
    this.stEvent = this.clock.schedule(this.stWrapAt, this.stFire);
  }

  private stFire = (at: number): void => {
    this.stFlag = 1;
    if (this.stCtrl & 2) this.pendException(EXC_SYSTICK);
    if (this.stLoad === 0) {
      this.stEvent = null;
      return;
    }
    this.stWrapAt = at + (this.stLoad + 1) * this.stDiv();
    this.stEvent = this.clock.schedule(this.stWrapAt, this.stFire);
  };

  scsRead(addr: number): number {
    switch (addr >>> 0) {
      case 0xe000e010: {
        const v = this.stCtrl | (this.stFlag << 16);
        this.stFlag = 0;
        return v;
      }
      case 0xe000e014: return this.stLoad;
      case 0xe000e018: return this.stCurrent();
      case 0xe000e01c: return 0x40000000 | 999; // 1 ms at 8 MHz / 8
      case 0xe000e100:
      case 0xe000e180: {
        let v = 0;
        for (let i = 0; i < 32; i++) if (this.enabled[EXC_IRQ0 + i]) v |= 1 << i;
        return v;
      }
      case 0xe000e200:
      case 0xe000e280: {
        let v = 0;
        for (let i = 0; i < 32; i++) if (this.pending[EXC_IRQ0 + i]) v |= 1 << i;
        return v;
      }
      case 0xe000ed00: return 0x410cc200;
      case 0xe000ed04: {
        let v = this.ipsr;
        let best = 0;
        let bestPrio = 256;
        let irqPending = 0;
        for (let e = 2; e < NUM_EXC; e++) {
          if (this.pending[e] && this.enabled[e]) {
            if (this.prio[e] < bestPrio) { bestPrio = this.prio[e]; best = e; }
            if (e >= EXC_IRQ0) irqPending = 1;
          }
        }
        v |= best << 12;
        v |= irqPending << 22;
        if (this.pending[EXC_SYSTICK]) v |= 1 << 26;
        if (this.pending[EXC_PENDSV]) v |= 1 << 28;
        if (this.pending[EXC_NMI]) v |= 1 << 31;
        return v;
      }
      case 0xe000ed0c: return 0xfa050000;
      case 0xe000ed10: return 0;
      case 0xe000ed14: return 0x208;
      case 0xe000ed1c: return (this.prio[EXC_SVC] << 30) | 0;
      case 0xe000ed20: return ((this.prio[EXC_SYSTICK] << 30) | (this.prio[EXC_PENDSV] << 22)) | 0;
    }
    const a = addr >>> 0;
    if (a >= 0xe000e400 && a < 0xe000e420) {
      const base = (a - 0xe000e400);
      let v = 0;
      for (let i = 0; i < 4; i++) v |= (this.prio[EXC_IRQ0 + base + i] << 6) << (8 * i);
      return v;
    }
    return 0;
  }

  scsWrite(addr: number, value: number): void {
    switch (addr >>> 0) {
      case 0xe000e010: {
        const old = this.stCtrl;
        const cur = this.stCurrent();
        this.stCtrl = value & 7;
        if ((this.stCtrl & 1) && (!(old & 1) || (old & 4) !== (this.stCtrl & 4))) {
          this.stStart(cur === 0 ? (this.stLoad === 0 ? 0 : this.stLoad + 1) : cur);
        } else if (!(this.stCtrl & 1) && (old & 1)) {
          this.stVal = cur;
          this.clock.cancel(this.stEvent);
          this.stEvent = null;
        }
        return;
      }
      case 0xe000e014:
        this.stLoad = value & 0xffffff;
        if ((this.stCtrl & 1) && this.stEvent === null && this.stLoad) this.stStart(this.stLoad + 1);
        return;
      case 0xe000e018:
        this.stVal = 0;
        this.stFlag = 0;
        if (this.stCtrl & 1) this.stStart(this.stLoad === 0 ? 0 : this.stLoad + 1);
        return;
      case 0xe000e100:
        for (let i = 0; i < 32; i++) if (value & (1 << i)) this.enabled[EXC_IRQ0 + i] = 1;
        this.irqCheck = true;
        return;
      case 0xe000e180:
        for (let i = 0; i < 32; i++) if (value & (1 << i)) this.enabled[EXC_IRQ0 + i] = 0;
        return;
      case 0xe000e200:
        for (let i = 0; i < 32; i++) if (value & (1 << i)) this.pending[EXC_IRQ0 + i] = 1;
        this.irqCheck = true;
        return;
      case 0xe000e280:
        for (let i = 0; i < 32; i++) if (value & (1 << i)) this.pending[EXC_IRQ0 + i] = 0;
        return;
      case 0xe000ed04:
        if (value & (1 << 31)) this.pendException(EXC_NMI);
        if (value & (1 << 28)) this.pendException(EXC_PENDSV);
        if (value & (1 << 27)) this.pending[EXC_PENDSV] = 0;
        if (value & (1 << 26)) this.pendException(EXC_SYSTICK);
        if (value & (1 << 25)) this.pending[EXC_SYSTICK] = 0;
        return;
      case 0xe000ed0c:
        if ((value >>> 16) === 0x05fa && (value & 4)) this.onResetRequest();
        return;
      case 0xe000ed1c:
        this.prio[EXC_SVC] = (value >>> 30) & 3;
        return;
      case 0xe000ed20:
        this.prio[EXC_SYSTICK] = (value >>> 30) & 3;
        this.prio[EXC_PENDSV] = (value >>> 22) & 3;
        return;
    }
    const a = addr >>> 0;
    if (a >= 0xe000e400 && a < 0xe000e420) {
      const base = a - 0xe000e400;
      for (let i = 0; i < 4; i++) this.prio[EXC_IRQ0 + base + i] = (value >>> (8 * i + 6)) & 3;
      this.irqCheck = true;
    }
  }

  /** True while an interrupt handler (not thread mode) is executing. */
  inHandler(): boolean {
    return this.ipsr !== 0;
  }

  irqEnabled(irq: number): boolean {
    return this.enabled[EXC_IRQ0 + irq] === 1;
  }
}
