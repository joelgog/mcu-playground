/**
 * Pin setup tool: choose a mode for each pin and get the register-level init
 * code, in the manner of a vendor pin configurator, with the reasons spelled out.
 */
import { useMemo, useState } from 'react';
import { STANDARD_DEVICES } from '../board/board';
import { DEBUG_PINS, PORTS, defaultConfig, describe, functionsOf, generate, notes, type PinConfig, type PinMode, type PinPull } from '../pinconfig/generate';
import { suggest, wiringOf } from '../pinconfig/suggest';
import { Icon } from './App';
import { Rich } from './ReferencePanel';
import { CodeBlock } from './SolutionPanel';
import { actions, currentExercise, useApp } from './store';

const MODES: Array<{ id: PinMode | 'off'; label: string; help: string }> = [
  { id: 'off', label: 'Not used', help: 'The pin keeps its reset state (a floating input) and no code is generated for it.' },
  { id: 'input', label: 'Input', help: 'The program reads the level of the pin from `GPIOx->IDR`. Use it for buttons and digital signals coming in.' },
  { id: 'output', label: 'Output', help: 'The program sets the level through `GPIOx->BSRR` or `GPIOx->ODR`. Use it for LEDs and digital signals going out.' },
  { id: 'af', label: 'Alternate function', help: 'A peripheral such as a timer, USART, I2C or SPI drives or reads the pin. The program configures that peripheral and no longer touches the pin.' },
  { id: 'analog', label: 'Analog', help: 'The pin is connected to the ADC and its digital input is switched off.' },
];

const SHORT: Record<PinMode, string> = { input: 'IN', output: 'OUT', af: 'AF', analog: 'ADC' };

function Choice<T extends string | number | boolean>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="pin-row">
      <span className="pin-row-label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={String(v)} role="radio" aria-checked={v === value} className={v === value ? 'active' : ''} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PinTool() {
  const tool = useApp((s) => s.pinTool);
  const exercise = useApp((s) => currentExercise(s));
  const [port, setPort] = useState<(typeof PORTS)[number]>('A');
  const [message, setMessage] = useState('');

  const wiring = useMemo(() => wiringOf(exercise ? STANDARD_DEVICES.filter((d) => exercise.devices.includes(d.id)) : STANDARD_DEVICES), [exercise]);
  const configs = useMemo(() => Object.values(tool.pins), [tool.pins]);
  const code = useMemo(() => generate(configs), [configs]);

  if (!tool.open) return null;

  const selected = tool.selected;
  const config = selected ? tool.pins[selected] : undefined;
  const wired = selected ? (wiring.get(selected) ?? []) : [];
  const hint = selected && wired.length ? suggest(selected, wired[0]) : null;
  const functions = selected ? functionsOf(selected) : [];
  const update = (patch: Partial<PinConfig>) => {
    if (!selected) return;
    setMessage('');
    actions.setPin(selected, { ...(config ?? defaultConfig(selected, wired[0]?.device.label)), ...patch });
  };
  const setMode = (mode: PinMode | 'off') => {
    if (!selected) return;
    setMessage('');
    if (mode === 'off') actions.setPin(selected, null);
    else update({ mode });
  };

  return (
    <aside className="reference pintool" aria-label="Pin setup">
      <header className="ref-head">
        <h2>Pin setup</h2>
        <span className="ref-head-space" />
        <button className="btn btn-small" onClick={actions.closePinTool} title="Back to the board">
          <Icon name="cross" /> Close
        </button>
      </header>
      <div className="ref-body">
        <div className="ref-page pin-page">
          <p>
            Pick a pin and say what it should do. The tool writes the register code for it, as a vendor configurator such as STM32CubeMX does for its GPIO init function, and tells you why each line is there.
          </p>

          <div className="pin-ports" role="tablist" aria-label="Port">
            {PORTS.map((p) => {
              const count = configs.filter((c) => c.pin[1] === p).length;
              return (
                <button key={p} role="tab" aria-selected={p === port} className={p === port ? 'active' : ''} onClick={() => setPort(p)}>
                  Port {p}
                  {count > 0 && <span className="badge">{count}</span>}
                </button>
              );
            })}
          </div>

          <div className="pin-grid">
            {Array.from({ length: 16 }, (_, n) => {
              const pin = `P${port}${n}`;
              const c = tool.pins[pin];
              const parts = wiring.get(pin);
              return (
                <button
                  key={pin}
                  className={`pin-cell${c ? ' set' : ''}${pin === selected ? ' selected' : ''}${parts ? ' wired' : ''}`}
                  onClick={() => {
                    setMessage('');
                    actions.selectPin(pin);
                  }}
                  title={parts ? parts.map((w) => w.device.label).join(', ') : 'Nothing connected on this board'}
                >
                  <span className="pin-name">{pin}</span>
                  <span className="pin-state">{c ? (c.mode === 'af' ? `AF${c.af}` : SHORT[c.mode]) : ''}</span>
                  <span className="pin-part">{parts ? parts[0].device.label : ''}</span>
                </button>
              );
            })}
          </div>

          {selected ? (
            <section className="pin-editor">
              <h3>
                {selected}
                <span className="ref-sub">{wired.length ? `connected to ${wired.map((w) => w.device.label).join(', ')}` : 'nothing connected on this board'}</span>
              </h3>

              {hint && (
                <p className="pin-hint">
                  <span>
                    <strong>Typical for this part:</strong> {describe(hint.config)}. {hint.reason}
                  </span>
                  <button className="btn btn-small" onClick={() => update(hint.config)}>
                    Use this
                  </button>
                </p>
              )}

              <Choice label="Mode" value={config?.mode ?? 'off'} options={MODES.map((m) => [m.id, m.label] as [PinMode | 'off', string])} onChange={setMode} />
              <p className="pin-help">
                <Rich text={MODES.find((m) => m.id === (config?.mode ?? 'off'))!.help} />
              </p>

              {config?.mode === 'af' &&
                (functions.length ? (
                  <div className="pin-row">
                    <span className="pin-row-label">Function</span>
                    <select value={config.af} onChange={(e) => update({ af: Number(e.target.value) })} aria-label="Alternate function">
                      {functions.map(([n, signal]) => (
                        <option key={n} value={n}>
                          AF{n}: {signal}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <p className="pin-warn">The simulator models no alternate function on {selected}. The code is still generated, with function 0.</p>
                ))}

              {config && (config.mode === 'output' || config.mode === 'af') && (
                <Choice
                  label="Output type"
                  value={config.openDrain}
                  options={[
                    [false, 'Push-pull'],
                    [true, 'Open-drain'],
                  ]}
                  onChange={(openDrain) => update({ openDrain })}
                />
              )}
              {config && config.mode !== 'analog' && (
                <Choice<PinPull>
                  label="Pull resistor"
                  value={config.pull}
                  options={[
                    ['none', 'None'],
                    ['up', 'Pull-up'],
                    ['down', 'Pull-down'],
                  ]}
                  onChange={(pull) => update({ pull })}
                />
              )}
              {config?.mode === 'output' && (
                <Choice
                  label="Start level"
                  value={config.startHigh}
                  options={[
                    [false, 'Low'],
                    [true, 'High'],
                  ]}
                  onChange={(startHigh) => update({ startHigh })}
                />
              )}
              {DEBUG_PINS.includes(selected) && config && (
                <p className="pin-warn">{selected} is a debug pin. On a real board, reconfiguring it cuts the debugger connection.</p>
              )}
            </section>
          ) : (
            <p className="pin-empty">Select a pin above. Pins with a part connected on this board show its name.</p>
          )}

          <h3>Generated code</h3>
          <CodeBlock code={code} />
          <div className="sol-actions">
            <button
              className="btn btn-primary"
              disabled={configs.length === 0}
              onClick={() => {
                const file = actions.applyPinSetup();
                setMessage(`Written to ${file}: pins_init() in front of main(), and a call to it at the start of main(). Ctrl+Z in the editor undoes it.`);
              }}
              title="Insert or update pins_init() in your code"
            >
              Add to my code
            </button>
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(code).then(
                  () => setMessage('Copied.'),
                  () => setMessage('Copying is blocked in this browser. Select the code and copy it by hand.'),
                );
              }}
            >
              Copy
            </button>
            <button
              className="btn btn-ghost"
              disabled={configs.length === 0}
              onClick={() => {
                setMessage('');
                actions.clearPins();
              }}
            >
              Clear all pins
            </button>
          </div>
          {message && <p className="pin-message">{message}</p>}

          {configs.length > 0 && (
            <>
              <h3>Why the code looks like this</h3>
              <ul className="pin-notes">
                {notes(configs).map((n, i) => (
                  <li key={i}>
                    <Rich text={n} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
