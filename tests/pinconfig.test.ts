/** The Pin setup tool: its generated C must compile cleanly and configure the simulated chip as requested. */
import { describe, expect, it } from 'vitest';
import { compile } from '../server/toolchain';
import { Mcu } from '../src/emu/mcu';
import { applyToSource, BEGIN_MARK, END_MARK, generate, parsePin, type PinConfig } from '../src/pinconfig/generate';

const base = { pull: 'none', openDrain: false, af: 0, startHigh: false } as const;

const CONFIGS: PinConfig[] = [
  { ...base, pin: 'PA5', mode: 'output', startHigh: true, note: 'On-board LED' },
  { ...base, pin: 'PC8', mode: 'output', openDrain: true, pull: 'up' },
  { ...base, pin: 'PB8', mode: 'input', pull: 'up' },
  { ...base, pin: 'PC13', mode: 'input' },
  { ...base, pin: 'PB9', mode: 'input', pull: 'down' },
  { ...base, pin: 'PA0', mode: 'analog' },
  { ...base, pin: 'PB10', mode: 'af', af: 2 },
  { ...base, pin: 'PB6', mode: 'af', af: 1, openDrain: true },
  { ...base, pin: 'PA2', mode: 'af', af: 1, pull: 'up' },
  { ...base, pin: 'PB15', mode: 'af', af: 0 },
];

const MODE = { input: 0, output: 1, af: 2, analog: 3 };
const PULL = { none: 0, up: 1, down: 2 };

describe('pin setup generator', () => {
  it('generates code that compiles without warnings and configures every pin as requested', async () => {
    const source = applyToSource('#include "stm32f0xx.h"\n\nint main(void)\n{\n    for (;;) {\n    }\n}\n', generate(CONFIGS));
    expect(source).toContain('    pins_init();\n    for (;;) {');
    const res = await compile([{ name: 'main.c', content: source }], { opt: 'Og' });
    expect(res.ok, res.log).toBe(true);
    expect(res.diagnostics.filter((d) => d.severity !== 'note')).toEqual([]);

    const mcu = new Mcu();
    mcu.load(res.elf!);
    mcu.runSeconds(0.01);
    expect(mcu.hints).toEqual([]);
    for (const c of CONFIGS) {
      const { port, n } = parsePin(c.pin);
      const gpio = mcu.ports.get(port)!;
      expect(gpio.mode(n), `${c.pin} mode`).toBe(MODE[c.mode]);
      if (c.mode !== 'analog') expect(gpio.pull(n), `${c.pin} pull`).toBe(PULL[c.pull]);
      if (c.mode === 'af') expect(gpio.af(n), `${c.pin} function`).toBe(c.af);
      if (c.mode === 'output' || c.mode === 'af') expect((gpio.otyper >>> n) & 1, `${c.pin} output type`).toBe(c.openDrain ? 1 : 0);
    }
    // start level of the push-pull output, and the pins that were not listed
    expect(mcu.net('PA5').level).toBe(1);
    expect(mcu.ports.get('A')!.mode(13)).toBe(2);
    expect(mcu.ports.get('A')!.mode(14)).toBe(2);
    expect(mcu.ports.get('C')!.mode(9)).toBe(0);
  });

  it('replaces an earlier generated block and does not add the call twice', () => {
    const first = applyToSource('#include "stm32f0xx.h"\n\nint main(void)\n{\n    for (;;) {\n    }\n}\n', generate([CONFIGS[0]]));
    const second = applyToSource(first, generate([CONFIGS[2]]));
    expect(second.split(BEGIN_MARK).length).toBe(2);
    expect(second.split(END_MARK).length).toBe(2);
    expect(second.match(/pins_init\(\);/g)?.length).toBe(1);
    expect(second).toContain('PB8: input with pull-up');
    expect(second).not.toContain('PA5:');
  });

  it('keeps CRLF line endings and copes with a file that has no main()', () => {
    const crlf = applyToSource('#include "stm32f0xx.h"\r\n\r\nint main(void)\r\n{\r\n}\r\n', generate([CONFIGS[0]]));
    expect(crlf.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const noMain = applyToSource('#include "drills.h"\n\nuint32_t f(void)\n{\n    return 0;\n}\n', generate([CONFIGS[0]]));
    expect(noMain.indexOf(BEGIN_MARK)).toBeGreaterThan(noMain.indexOf('#include'));
    expect(noMain.indexOf(BEGIN_MARK)).toBeLessThan(noMain.indexOf('uint32_t f'));
    expect(noMain).not.toContain('pins_init();');
  });
});
