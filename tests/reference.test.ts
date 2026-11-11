/**
 * The in-app register reference must agree with the official headers:
 * every macro exists, every bit position matches the header's _Pos value,
 * and every register offset matches the peripheral struct (checked by
 * compiling offsetof() for the real chip and running it on the emulator).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRMWARE_DIR } from '../server/toolchain';
import { EXERCISES } from '../src/exercises';
import { PERIPHERALS, SYMBOLS, concreteMacros, lookup, registerDoc } from '../src/reference/registers';
import { SOURCES } from '../src/reference/sources';
import { buildBare, runBare } from './helpers';

const header =
  readFileSync(path.join(FIRMWARE_DIR, 'cmsis', 'stm32f072xb.h'), 'utf8') + '\n' + readFileSync(path.join(FIRMWARE_DIR, 'cmsis', 'core_cm0.h'), 'utf8');

const defined = new Set<string>();
const positions = new Map<string, number>();
for (const m of header.matchAll(/^\s*#define\s+(\w+)\b(.*)$/gm)) {
  defined.add(m[1]);
  const pos = /^\s*\(?\s*(\d+)U?L?\s*\)?\s*(?:\/\*.*)?$/.exec(m[2]);
  if (m[1].endsWith('_Pos') && pos) positions.set(m[1], Number(pos[1]));
}

describe('register reference', () => {
  it('uses only macros that exist in the CMSIS headers', () => {
    const missing = concreteMacros()
      .map((m) => m.macro)
      .filter((m) => !defined.has(m));
    expect(missing).toEqual([]);
  });

  it('states the same bit position as the header for every field', () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const { macro, periph, reg, field } of concreteMacros()) {
      const low = /^(?:\d+:)?(\d+)$/.exec(field.bits);
      if (!low) continue;
      const posName = `${macro.replace(/_Msk$/, '')}_Pos`;
      const pos = positions.get(posName);
      if (pos === undefined) continue;
      checked++;
      if (pos !== Number(low[1])) wrong.push(`${periph.id}->${reg.name} ${field.name}: reference says bit ${low[1]}, header says ${pos}`);
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(120);
  });

  it('states the same field width as the header mask', async () => {
    // compile the masks for the real chip and compare them with the documented bit ranges
    const items = concreteMacros().filter((m) => /^(?:\d+:)?\d+$/.test(m.field.bits));
    const lines = items.map((m, i) => `    out(${i}, (uint32_t)(${m.macro}));`).join('\n');
    const src = `#include "stm32f0xx.h"\n#include <stdio.h>\nstatic void out(int i, uint32_t v) { printf("%d %lu\\n", i, (unsigned long)v); }\nint main(void)\n{\n${lines}\n    fflush(stdout);\n    return 0;\n}\n`;
    const run = runBare(await buildBare([{ name: 'main.c', content: src }], 'O1'), 4e8);
    expect(run.cpu.halted).toBe('exit');
    const values = new Map(run.out.trim().split('\n').map((l) => l.split(' ').map(Number) as [number, number]));
    const wrong: string[] = [];
    items.forEach((m, i) => {
      const [hi, lo] = m.field.bits.includes(':') ? m.field.bits.split(':').map(Number) : [Number(m.field.bits), Number(m.field.bits)];
      const mask = Number((((1n << BigInt(hi - lo + 1)) - 1n) << BigInt(lo)) & 0xffffffffn);
      const actual = values.get(i);
      // single-value macros (e.g. SYSCFG_EXTICR4_EXTI13_PC) are not masks; only compare when the header value is a contiguous mask at lo
      if (actual === undefined) wrong.push(`${m.macro}: no value`);
      else if (actual !== mask) wrong.push(`${m.macro}: reference bits ${m.field.bits} = 0x${mask.toString(16)}, header = 0x${actual.toString(16)}`);
    });
    expect(wrong).toEqual([]);
  });

  it('states the same register offsets as the peripheral structs', async () => {
    const regs = PERIPHERALS.flatMap((p) => p.registers.map((r) => ({ p, r })));
    const lines = regs.map(({ p, r }, i) => `    out(${i}, (uint32_t)offsetof(${p.struct}, ${r.member}));`).join('\n');
    const src = `#include "stm32f0xx.h"\n#include <stddef.h>\n#include <stdio.h>\nstatic void out(int i, uint32_t v) { printf("%d %lu\\n", i, (unsigned long)v); }\nint main(void)\n{\n${lines}\n    fflush(stdout);\n    return 0;\n}\n`;
    const run = runBare(await buildBare([{ name: 'main.c', content: src }], 'O1'), 4e8);
    expect(run.cpu.halted).toBe('exit');
    const values = new Map(run.out.trim().split('\n').map((l) => l.split(' ').map(Number) as [number, number]));
    const wrong: string[] = [];
    regs.forEach(({ p, r }, i) => {
      if (values.get(i) !== r.offset) wrong.push(`${p.id}->${r.name}: reference 0x${r.offset.toString(16)}, header 0x${(values.get(i) ?? -1).toString(16)}`);
    });
    expect(wrong).toEqual([]);
    expect(regs.length).toBeGreaterThan(55);
  });

  it('documents the CMSIS functions it mentions', () => {
    const headerAndSystem = header + readFileSync(path.join(FIRMWARE_DIR, 'cmsis', 'cmsis_gcc.h'), 'utf8') + readFileSync(path.join(FIRMWARE_DIR, 'system_stm32f0xx.c'), 'utf8');
    for (const s of SYMBOLS) expect(headerAndSystem.includes(s.name), `${s.name} exists`).toBe(true);
  });

  it('cites only known source documents', () => {
    const ids = new Set(SOURCES.map((s) => s.id));
    for (const p of PERIPHERALS) expect(ids.has(p.source.doc), `${p.id} source`).toBe(true);
    for (const s of SYMBOLS) expect(ids.has(s.source.doc), `${s.name} source`).toBe(true);
    for (const s of SOURCES) expect(s.url.startsWith('https://')).toBe(true);
  });

  it('resolves the expressions the editor looks up', () => {
    expect(lookup('RCC->AHBENR')?.reg.name).toBe('AHBENR');
    expect(lookup('GPIOA->MODER')?.periph.id).toBe('GPIO');
    expect(lookup('GPIOB->AFR[1]')?.reg.name).toBe('AFR');
    expect(lookup('TIM3->CCR2')?.reg.name).toBe('CCR1');
    expect(lookup('RCC_AHBENR_GPIOAEN')?.field?.name).toBe('IOPAEN');
    expect(lookup('GPIO_MODER_MODER5_0')?.reg.name).toBe('MODER');
    expect(lookup('GPIO_MODER_MODER5_0')?.field?.name).toBe('MODERy');
    expect(lookup('TIM_CCMR1_OC1M_2')?.field?.name).toBe('OC1M');
    expect(lookup('USART_ISR_RXNE')?.reg.name).toBe('ISR');
    expect(lookup('SysTick->CTRL')?.periph.id).toBe('SysTick');
    expect(lookup('not_a_register')).toBeNull();
  });

  it('links every exercise to registers that exist', () => {
    for (const ex of EXERCISES) {
      expect(ex.refs.length, `${ex.id} has references`).toBeGreaterThan(0);
      for (const ref of ex.refs) {
        const [periph, reg] = ref.split('.');
        const ok = reg ? registerDoc(periph, reg) !== null : SYMBOLS.some((s) => s.name === periph);
        expect(ok, `${ex.id}: ${ref}`).toBe(true);
      }
    }
  });
});
