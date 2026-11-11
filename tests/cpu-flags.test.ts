/**
 * Instruction-level flag tests. Each probe in tests/c/flags.S runs one instruction;
 * the expected result and NZCV flags come from an independent BigInt model written
 * straight from the ARMv6-M pseudo-code (AddWithCarry, LSL_C, LSR_C, ASR_C, ROR_C).
 */
import { describe, expect, it } from 'vitest';
import { buildBare, readC, runBare } from './helpers';

const M32 = 0xffffffffn;
const u = (x: number) => BigInt(x >>> 0);
const s = (x: number) => BigInt(x | 0);

interface R {
  res: number;
  n: number;
  z: number;
  c: number;
  v: number;
}
type F = { n: number; z: number; c: number; v: number };

function nz(res: number, f: F, c = f.c, v = f.v): R {
  return { res: res >>> 0, n: res >>> 31, z: (res >>> 0) === 0 ? 1 : 0, c, v };
}
function addWithCarry(a: number, b: number, carry: number): R {
  const usum = u(a) + u(b) + BigInt(carry);
  const ssum = s(a) + s(b) + BigInt(carry);
  const res = Number(usum & M32);
  return { res, n: res >>> 31, z: res === 0 ? 1 : 0, c: BigInt(res) === usum ? 0 : 1, v: s(res) === ssum ? 0 : 1 };
}
function shiftReg(kind: 'lsl' | 'lsr' | 'asr' | 'ror', a: number, b: number, f: F): R {
  const nsh = b & 0xff;
  if (nsh === 0) return nz(a, f);
  const amount = BigInt(nsh);
  if (kind === 'lsl') {
    const ext = u(a) << amount;
    return nz(Number(ext & M32), f, Number((ext >> 32n) & 1n));
  }
  if (kind === 'lsr') {
    return nz(Number((u(a) >> amount) & M32), f, Number((u(a) >> (amount - 1n)) & 1n));
  }
  if (kind === 'asr') {
    return nz(Number((s(a) >> amount) & M32), f, Number((s(a) >> (amount - 1n)) & 1n));
  }
  const m = BigInt(nsh % 32);
  const res = Number(((u(a) >> m) | (u(a) << (32n - m))) & M32);
  return nz(res, f, res >>> 31);
}
const keep = (res: number, f: F): R => ({ res: res >>> 0, ...f });

const MODEL: Record<string, (a: number, b: number, f: F) => R> = {
  adds: (a, b) => addWithCarry(a, b, 0),
  subs: (a, b) => addWithCarry(a, ~b, 1),
  adcs: (a, b, f) => addWithCarry(a, b, f.c),
  sbcs: (a, b, f) => addWithCarry(a, ~b, f.c),
  cmp: (a, b) => ({ ...addWithCarry(a, ~b, 1), res: a >>> 0 }),
  cmn: (a, b) => ({ ...addWithCarry(a, b, 0), res: a >>> 0 }),
  negs: (_a, b) => addWithCarry(~b, 0, 1),
  lsls: (a, b, f) => shiftReg('lsl', a, b, f),
  lsrs: (a, b, f) => shiftReg('lsr', a, b, f),
  asrs: (a, b, f) => shiftReg('asr', a, b, f),
  rors: (a, b, f) => shiftReg('ror', a, b, f),
  muls: (a, b, f) => nz(Number((u(a) * u(b)) & M32), f),
  ands: (a, b, f) => nz(a & b, f),
  eors: (a, b, f) => nz(a ^ b, f),
  orrs: (a, b, f) => nz(a | b, f),
  bics: (a, b, f) => nz(a & ~b, f),
  mvns: (_a, b, f) => nz(~b, f),
  tst: (a, b, f) => ({ ...nz(a & b, f), res: a >>> 0 }),
  lsl1: (a, _b, f) => shiftReg('lsl', a, 1, f),
  lsl31: (a, _b, f) => shiftReg('lsl', a, 31, f),
  lsr1: (a, _b, f) => shiftReg('lsr', a, 1, f),
  lsr32: (a, _b, f) => shiftReg('lsr', a, 32, f),
  asr1: (a, _b, f) => shiftReg('asr', a, 1, f),
  asr32: (a, _b, f) => shiftReg('asr', a, 32, f),
  movs: (_a, b, f) => nz(b, f),
  add3: (a) => addWithCarry(a, 7, 0),
  sub3: (a) => addWithCarry(a, ~7, 1),
  add8: (a) => addWithCarry(a, 255, 0),
  sub8: (a) => addWithCarry(a, ~255, 1),
  cmp8: (a) => ({ ...addWithCarry(a, ~200, 1), res: a >>> 0 }),
  mov8: (_a, _b, f) => nz(0, f),
  addhi: (a, b, f) => keep(Number((u(a) + u(b)) & M32), f),
  cmphi: (a, b) => ({ ...addWithCarry(a, ~b, 1), res: a >>> 0 }),
  sxtb: (_a, b, f) => keep((b << 24) >> 24, f),
  sxth: (_a, b, f) => keep((b << 16) >> 16, f),
  uxtb: (_a, b, f) => keep(b & 0xff, f),
  uxth: (_a, b, f) => keep(b & 0xffff, f),
  rev: (_a, b, f) => keep(Number(BigInt.asUintN(32, ((u(b) & 0xffn) << 24n) | ((u(b) & 0xff00n) << 8n) | ((u(b) >> 8n) & 0xff00n) | (u(b) >> 24n))), f),
  rev16: (_a, b, f) => keep(Number(((u(b) & 0x00ff00ffn) << 8n) | ((u(b) >> 8n) & 0x00ff00ffn)), f),
  revsh: (_a, b, f) => {
    const lo = Number(((u(b) & 0xffn) << 8n) | ((u(b) >> 8n) & 0xffn));
    return keep((lo << 16) >> 16, f);
  },
};

const hex8 = (x: number) => (x >>> 0).toString(16).padStart(8, '0');

describe('CPU flag behaviour per instruction', () => {
  it('matches the ARMv6-M reference model for every probe and operand pair', async () => {
    const elf = await buildBare([await readC('flags_main.c'), await readC('flags.S')], 'O1');
    const run = runBare(elf, 2e10);
    expect(run.cpu.lastFault).toBeNull();
    expect(run.cpu.halted).toBe('exit');
    const lines = run.out.trim().split('\n');
    expect(lines.length).toBe(Object.keys(MODEL).length * 20 * 20 * 4);
    const mismatches: string[] = [];
    for (const line of lines) {
      const [op, as, bs, fs] = line.split(' ');
      const a = parseInt(as, 16);
      const b = parseInt(bs, 16);
      const fi = parseInt(fs, 16);
      const f: F = { n: (fi >> 3) & 1, z: (fi >> 2) & 1, c: (fi >> 1) & 1, v: fi & 1 };
      const m = MODEL[op](a | 0, b | 0, f);
      const expected = `${op} ${as} ${bs} ${fs} ${hex8(m.res)} ${((m.n << 3) | (m.z << 2) | (m.c << 1) | m.v).toString(16)}`;
      if (expected !== line && mismatches.length < 20) mismatches.push(`got ${line} | want ${expected}`);
    }
    expect(mismatches).toEqual([]);
  });
});
