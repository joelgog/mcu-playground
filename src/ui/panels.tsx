import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Exercise } from '../exercises';
import { GROUPS } from '../exercises';
import { PERIPHERALS, registerDoc } from '../reference/registers';
import { sourceById } from '../reference/sources';
import { EXERCISES, SANDBOX, actions, useApp } from './store';
import { Icon } from './App';

/** Minimal rich text: paragraphs separated by blank lines, `code` in backticks. */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\n+/).map((para, i) => (
        <p key={i}>
          {para.split(/(`[^`]+`)/).map((part, j) =>
            part.startsWith('`') ? <code key={j}>{part.slice(1, -1)}</code> : <Fragment key={j}>{part}</Fragment>,
          )}
        </p>
      ))}
    </>
  );
}

// ------------------------------------------------------------ exercise list

export function ExerciseList() {
  const projectId = useApp((s) => s.projectId);
  const passed = useApp((s) => s.passed);
  const done = EXERCISES.filter((e) => passed[e.id]).length;
  const number = new Map(EXERCISES.map((e, i) => [e.id, i + 1]));
  return (
    <nav className="sidebar" aria-label="Projects">
      <button className="side-item side-help" onClick={() => actions.openReference('app', null)} title="A two-minute tour of the playground">
        <span className="side-mark side-mark-help" aria-hidden="true">
          ?
        </span>
        <span className="side-text">
          <span className="side-title">How it works</span>
          <span className="side-sub">Two-minute tour of the app</span>
        </span>
      </button>
      <button className={`side-item side-sandbox${projectId === SANDBOX ? ' active' : ''}`} onClick={() => actions.selectProject(SANDBOX)} title="Sandbox: full board, your own code">
        <span className="side-mark side-mark-sandbox" aria-hidden="true">
          S
        </span>
        <span className="side-title">Sandbox</span>
        <span className="side-sub">Full board, your own code</span>
      </button>
      <div className="side-heading">
        <span>Exercises</span>
        <span className="side-progress">
          {done} of {EXERCISES.length} done
        </span>
      </div>
      <div className="side-scroll">
        {GROUPS.map((g) => (
          <Fragment key={g.title}>
            <div className="side-group">{g.title}</div>
            {EXERCISES.filter((e) => g.ids.includes(e.id)).map((e) => (
              <button key={e.id} className={`side-item${projectId === e.id ? ' active' : ''}`} onClick={() => actions.selectProject(e.id)} title={`${e.title}: ${e.summary}`}>
                <span className={`side-mark${passed[e.id] ? ' done' : ''}`} aria-label={passed[e.id] ? 'done' : 'not done'}>
                  {passed[e.id] ? <Icon name="check" /> : number.get(e.id)}
                </span>
                <span className="side-text">
                  <span className="side-title">{e.title}</span>
                  <span className="side-sub">{e.summary}</span>
                </span>
              </button>
            ))}
          </Fragment>
        ))}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------- exercise brief

/** A register ("RCC.AHBENR") or core function ("NVIC_EnableIRQ") as a chip that opens its reference entry. */
export function RefChip({ id }: { id: string }) {
  const [periph, reg] = id.split('.');
  const found = reg ? registerDoc(periph, reg) : null;
  const instance = PERIPHERALS.find((p) => p.id === periph)?.instances[0] ?? periph;
  return (
    <button
      className="ref-chip"
      title={found ? `${found.reg.title}: ${found.reg.what}` : 'Core function: open the reference'}
      onClick={() => (found ? actions.openReference(periph, reg) : actions.openReference('docs', null))}
    >
      {found ? `${periph === 'GPIO' ? 'GPIOx' : periph === 'TIM' ? 'TIMx' : instance}->${reg}` : periph.startsWith('System') ? periph : `${periph}()`}
    </button>
  );
}

export function ExerciseBrief({ exercise }: { exercise: Exercise }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [exercise.id]);
  return (
    <section className="brief">
      <div className="brief-task">
        <span className="brief-label">Your task</span>
        <Prose text={exercise.brief} />
      </div>
      <div className="brief-refs">
        <span className="brief-refs-label">Registers for this task</span>
        {exercise.refs.map((ref) => (
          <RefChip key={ref} id={ref} />
        ))}
        <span className="brief-refs-label brief-sources">
          Documented in{' '}
          {exercise.sources.map((id, i) => (
            <Fragment key={id}>
              {i > 0 && ', '}
              <button className="brief-source" onClick={() => actions.openReference('docs', null)} title={sourceById(id).title}>
                {sourceById(id).short}
              </button>
            </Fragment>
          ))}
        </span>
      </div>
      <div className="brief-actions">
        <button className="btn btn-small btn-help" onClick={() => actions.openSolution(false)} title="The solution in steps: the reason for each step first, the code only when you ask for it">
          <Icon name="steps" /> Step-by-step help
        </button>
        <button className="disclosure" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className={`caret${open ? ' open' : ''}`}>
            <Icon name="chevron" />
          </span>
          What an interviewer is looking for
        </button>
      </div>
      {open && (
        <div className="brief-background">
          <Prose text={exercise.background} />
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ checks

export function ChecksPanel({ exercise }: { exercise: Exercise }) {
  const check = useApp((s) => s.checks[exercise.id]);
  const passed = useApp((s) => !!s.passed[exercise.id]);
  const solutionOpen = useApp((s) => s.solution.open);
  const status = check?.status ?? 'idle';
  const results = check?.results ?? [];
  const allPass = status === 'done' && results.length > 0 && results.every((r) => r.pass);

  return (
    <section className="checks">
      <div className="checks-head">
        <h2>Checks</h2>
        <div className="checks-actions">
          <button
            className="btn btn-small btn-ghost"
            title="The model solution with an explanation of every step"
            onClick={() => {
              if (solutionOpen) actions.closeSolution();
              else if (passed || window.confirm('Show the complete solution? "Step-by-step help" above the editor gives hints first and keeps the code folded.')) {
                actions.openSolution(true);
              }
            }}
          >
            {solutionOpen ? 'Hide solution' : 'Show solution'}
          </button>
          <button
            className="btn btn-small btn-ghost"
            onClick={() => {
              if (window.confirm('Reset this exercise to its starting code? Your changes will be lost.')) actions.resetProject();
            }}
          >
            Start over
          </button>
          <button className="btn btn-small btn-primary" onClick={() => void actions.runChecks()} disabled={status === 'running'}>
            <Icon name="check" /> {status === 'running' ? 'Checking…' : 'Run checks'}
          </button>
        </div>
      </div>
      {status === 'idle' && (
        <p className="checks-empty">
          Runs your code on a fresh board with scripted button presses and sensor values, and measures what the pins do
          {exercise.opt ? ` (built with -${exercise.opt})` : ''}.
        </p>
      )}
      {status === 'build-error' && <p className="checks-empty checks-fail">The code does not compile yet. See Build output.</p>}
      {status === 'running' && <p className="checks-empty">Simulating…</p>}
      {status === 'done' && (
        <ul className="check-list">
          {results.map((r, i) => (
            <li key={i} className={r.pass ? 'pass' : 'fail'}>
              <span className="check-icon">
                <Icon name={r.pass ? 'check' : 'cross'} />
              </span>
              <span className="check-text">
                <span className="check-name">{r.name}</span>
                <span className="check-detail">{r.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {allPass && (
        <p className="checks-done">
          All checks pass. Now compare with the{' '}
          <button className="brief-source" onClick={() => actions.openSolution(true)}>
            model solution
          </button>{' '}
          and practise the "How to say it in an interview" answer out loud.
        </p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ serial

export function SerialPanel() {
  const text = useApp((s) => s.serial);
  const hasConsole = useApp((s) => s.specs.length === 0 || s.specs.some((d) => d.kind === 'console'));
  const [line, setLine] = useState('');
  const [ending, setEnding] = useState('\n');
  const out = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = out.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  if (!hasConsole) return <div className="dock-empty">This exercise has no serial console connected.</div>;

  return (
    <div className="serial">
      <pre
        ref={out}
        className="serial-out"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text || <span className="placeholder">Output from printf() and USART2 appears here. 115200 baud, 8N1, on PA2 / PA3.</span>}
      </pre>
      <form
        className="serial-in"
        onSubmit={(e) => {
          e.preventDefault();
          actions.sendSerial(line + ending);
          setLine('');
        }}
      >
        <input value={line} onChange={(e) => setLine(e.target.value)} placeholder="Type text to send to the chip" aria-label="Text to send" />
        <select value={ending} onChange={(e) => setEnding(e.target.value)} aria-label="Line ending">
          <option value={'\n'}>+ newline</option>
          <option value={'\r\n'}>+ CR LF</option>
          <option value="">no ending</option>
        </select>
        <button className="btn btn-small" type="submit">
          Send
        </button>
        <button className="btn btn-small btn-ghost" type="button" onClick={actions.clearSerial}>
          Clear
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- problems

function LocationLink({ pc }: { pc: number }) {
  const loc = useApp((s) => s.locations[pc]);
  if (!loc || !loc.line) return <span className="loc">at 0x{pc.toString(16).padStart(8, '0')}</span>;
  return (
    <button className="loc loc-link" onClick={() => actions.reveal(loc.file, loc.line)}>
      {loc.file}:{loc.line}
      {loc.func && loc.func !== '??' ? ` in ${loc.func}()` : ''}
    </button>
  );
}

export function ProblemsPanel() {
  const hints = useApp((s) => s.hints);
  const fault = useApp((s) => s.fault);
  const frame = useApp((s) => s.frame);
  const stackFree = frame ? frame.cpu.sp - frame.cpu.stackLimit : null;

  if (!fault && hints.length === 0) {
    return (
      <div className="dock-empty">
        Nothing to report. When your code does something that silently fails on real hardware (a missing clock, a floating input, an interrupt flag
        that is never cleared), the simulator explains it here.
      </div>
    );
  }
  return (
    <div className="problems">
      {fault && (
        <article className="problem problem-fault">
          <header>
            <span className="problem-kind">HardFault</span>
            <LocationLink pc={fault.pc} />
          </header>
          <p>{fault.message}</p>
          <dl className="problem-tech">
            <dt>Faulting instruction</dt>
            <dd>0x{fault.pc.toString(16).padStart(8, '0')}</dd>
            <dt>Address involved</dt>
            <dd>0x{fault.addr.toString(16).padStart(8, '0')}</dd>
            <dt>Called from</dt>
            <dd>
              <LocationLink pc={fault.lr & ~1} />
            </dd>
            <dt>Stack pointer</dt>
            <dd>
              0x{fault.sp.toString(16).padStart(8, '0')}
              {stackFree !== null && stackFree < 64 ? ' (stack has overflowed into the globals)' : ''}
            </dd>
          </dl>
          <p className="problem-note">
            {fault.lockup
              ? 'The CPU is locked up. Reset the chip to continue.'
              : 'The simulation is paused at the fault. Resume to continue into HardFault_Handler, or fix the code and build again.'}
          </p>
        </article>
      )}
      {hints.map((h) => (
        <article key={h.id} className="problem">
          <header>
            <span className="problem-kind">Hint</span>
            <LocationLink pc={h.pc} />
            <span className="problem-time">{h.timeSec.toFixed(3)} s</span>
          </header>
          <Prose text={h.message} />
        </article>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- build

export function BuildPanel() {
  const build = useApp((s) => s.build);
  let body: ReactNode;
  if (build.status === 'idle') body = <div className="dock-empty">Press Build and run (Ctrl+Enter) to compile with arm-none-eabi-gcc.</div>;
  else if (build.status === 'building') body = <div className="dock-empty">Compiling…</div>;
  else {
    const issues = build.diagnostics.filter((d) => d.severity !== 'note');
    body = (
      <div className="build">
        <p className={`build-summary ${build.status === 'ok' ? 'ok' : 'fail'}`}>
          {build.status === 'ok'
            ? issues.length
              ? `Built with ${issues.length} warning${issues.length > 1 ? 's' : ''}.`
              : 'Built without warnings.'
            : 'Build failed.'}
        </p>
        {issues.length > 0 && (
          <ul className="diag-list">
            {issues.map((d, i) => (
              <li key={i} className={d.severity}>
                <button className="loc loc-link" onClick={() => actions.reveal(d.file, d.line)}>
                  {d.file}:{d.line}
                </button>
                <span className="diag-sev">{d.severity}</span>
                <span>{d.message}</span>
              </li>
            ))}
          </ul>
        )}
        {build.log.trim() && (
          <details className="build-log" open={build.status === 'error' && issues.length === 0}>
            <summary>Full compiler output</summary>
            <pre>{build.log}</pre>
          </details>
        )}
      </div>
    );
  }
  return <>{body}</>;
}
