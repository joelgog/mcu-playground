/** The explained model solutions must stay in step with the code they explain. */
import { describe, expect, it } from 'vitest';
import { EXERCISES, GROUPS, walkthroughFor } from '../src/exercises';
import { registerDoc, SYMBOLS } from '../src/reference/registers';

/** Non-empty lines without indentation, so a passage can be quoted at any nesting depth. */
function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function contains(haystack: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** A step may quote several passages, separated by a line holding only "...". */
function passages(code: string): string[][] {
  const out: string[][] = [[]];
  for (const l of lines(code)) {
    if (l === '...') out.push([]);
    else out[out.length - 1].push(l);
  }
  return out;
}

describe('explained solutions', () => {
  for (const ex of EXERCISES) {
    const w = walkthroughFor(ex.id);

    it(`${ex.id}: is complete`, () => {
      expect(w.idea.length).toBeGreaterThan(60);
      expect(w.say.length).toBeGreaterThan(120);
      expect(w.steps.length).toBeGreaterThanOrEqual(3);
      expect(w.mistakes.length).toBeGreaterThanOrEqual(3);
      for (const s of w.steps) {
        expect(s.title.length).toBeGreaterThan(5);
        expect(s.why.length, `${s.title}: why`).toBeGreaterThan(40);
        expect(s.how.length, `${s.title}: how`).toBeGreaterThan(40);
      }
    });

    it(`${ex.id}: every quoted passage is in the reference solution`, () => {
      const solution = lines(Object.values(ex.solution).join('\n'));
      for (const s of w.steps) {
        for (const p of passages(s.code)) {
          expect(p.length, `${s.title}: empty passage`).toBeGreaterThan(0);
          expect(contains(solution, p), `"${s.title}" quotes code that is not in the solution:\n${p.join('\n')}`).toBe(true);
        }
      }
    });

    it(`${ex.id}: every register link resolves`, () => {
      for (const s of w.steps) {
        for (const ref of s.refs ?? []) {
          const [periph, reg] = ref.split('.');
          const ok = reg ? !!registerDoc(periph, reg) : SYMBOLS.some((sym) => sym.name === periph);
          expect(ok, `${s.title}: unknown reference ${ref}`).toBe(true);
        }
      }
    });
  }

  it('every exercise belongs to exactly one group', () => {
    const grouped = GROUPS.flatMap((g) => g.ids);
    expect([...grouped].sort()).toEqual(EXERCISES.map((e) => e.id).sort());
    expect(grouped).toEqual(EXERCISES.map((e) => e.id));
  });
});
