import { describe, expect, it } from 'vitest';
import { OptLevel } from '../server/toolchain';
import { buildBare, hostGccAvailable, readC, runBare, runNative } from './helpers';

describe('CPU differential tests (emulated Cortex-M0 vs native host)', async () => {
  const haveHost = await hostGccAvailable();
  const src = await readC('diff_main.c');
  const native = haveHost ? await runNative([src]) : '';

  it.runIf(haveHost)('native reference ran to completion', () => {
    expect(native.endsWith('done\n')).toBe(true);
    expect(native.split('\n').length).toBeGreaterThan(40);
  });

  for (const opt of ['O0', 'Og', 'O2', 'Os'] as OptLevel[]) {
    it.runIf(haveHost)(`matches native output at -${opt}`, async () => {
      const elf = await buildBare([src], opt, ['-ffp-contract=off']);
      const run = runBare(elf);
      expect(run.cpu.lastFault).toBeNull();
      expect(run.cpu.halted).toBe('exit');
      expect(run.out).toBe(native);
    });
  }
});
