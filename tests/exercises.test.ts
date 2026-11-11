/** Every reference solution must pass its checks; every unmodified starter must fail at least one. */
import { describe, expect, it } from 'vitest';
import { compile, OptLevel } from '../server/toolchain';
import { EXERCISES } from '../src/exercises';
import { runCheck } from '../src/exercises/runner';
import { Exercise } from '../src/exercises/types';

async function build(ex: Exercise, files: Record<string, string>, opt: OptLevel): Promise<Uint8Array> {
  const all = { ...ex.support, ...files };
  const res = await compile(Object.entries(all).map(([name, content]) => ({ name, content })), { opt });
  if (!res.ok || !res.elf) throw new Error(`${ex.id} failed to build:\n${res.log}`);
  const warnings = res.diagnostics.filter((d) => d.severity === 'warning');
  expect(warnings, `${ex.id} builds without warnings`).toEqual([]);
  return res.elf;
}

describe('exercises', () => {
  it('have unique ids and complete metadata', () => {
    expect(new Set(EXERCISES.map((e) => e.id)).size).toBe(EXERCISES.length);
    for (const e of EXERCISES) {
      expect(e.title.length).toBeGreaterThan(3);
      expect(e.brief.length).toBeGreaterThan(40);
      expect(e.background.length).toBeGreaterThan(100);
      expect(Object.keys(e.starter)).toEqual(Object.keys(e.solution));
    }
  });

  for (const ex of EXERCISES) {
    const levels: OptLevel[] = ex.opt ? [ex.opt] : ['Og', 'O2'];
    for (const opt of levels) {
      it(`${ex.id}: reference solution passes at -${opt}`, async () => {
        const results = runCheck(ex, await build(ex, ex.solution, opt));
        expect(results.length).toBeGreaterThan(1);
        expect(results.filter((r) => !r.pass)).toEqual([]);
      });
    }
    it(`${ex.id}: unmodified starter fails`, async () => {
      const results = runCheck(ex, await build(ex, ex.starter, ex.opt ?? 'Og'));
      expect(results.some((r) => !r.pass)).toBe(true);
    });
  }
});
