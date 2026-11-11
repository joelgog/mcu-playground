import { useEffect, useState } from 'react';
import { actions, currentExercise, useApp, type OptLevel } from './store';
import { BoardPanel } from './BoardPanel';
import { CodeEditor, FileTabs } from './Editor';
import { BuildPanel, ChecksPanel, ExerciseBrief, ExerciseList, ProblemsPanel, SerialPanel } from './panels';
import { TracePanel } from './TracePanel';

function fmtTime(sec: number): string {
  if (sec < 60) return `${sec.toFixed(2)} s`;
  const m = Math.floor(sec / 60);
  return `${m} min ${(sec - m * 60).toFixed(0).padStart(2, '0')} s`;
}

function fmtHz(hz: number): string {
  return hz >= 1e6 ? `${+(hz / 1e6).toFixed(2)} MHz` : `${+(hz / 1e3).toFixed(1)} kHz`;
}

function StatusChip() {
  const frame = useApp((s) => s.frame);
  const build = useApp((s) => s.build.status);
  const fault = useApp((s) => s.fault);
  if (build === 'building') return <span className="chip chip-info">Building…</span>;
  if (!frame) return <span className="chip">Not running</span>;
  if (fault && frame.state !== 'running') return <span className="chip chip-danger">Stopped at a fault</span>;
  if (frame.state === 'halted') {
    const why = frame.haltReason === 'exit' ? 'main() returned' : frame.haltReason === 'breakpoint' ? 'Breakpoint' : 'CPU locked up';
    return <span className="chip chip-danger">{why}</span>;
  }
  if (frame.state === 'paused') return <span className="chip chip-warn">Paused</span>;
  const mode = frame.cpu.ipsr !== 0 ? 'in interrupt' : frame.cpu.sleepFrac > 0.5 ? `asleep ${Math.round(frame.cpu.sleepFrac * 100)} %` : 'running';
  return <span className="chip chip-ok">{mode}</span>;
}

function TopBar() {
  const build = useApp((s) => s.build.status);
  const frame = useApp((s) => s.frame);
  const opt = useApp((s) => s.opt);
  const speed = useApp((s) => s.speed);
  const exercise = useApp((s) => currentExercise(s));
  const running = frame?.state === 'running';
  const loaded = !!frame && frame.state !== 'empty';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void actions.buildAndRun();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="topbar">
      <div className="brand">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
          <rect x="8" y="8" width="16" height="16" rx="2" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="2">
            <path d="M12 3v5M16 3v5M20 3v5M12 24v5M16 24v5M20 24v5M3 12h5M3 16h5M3 20h5M24 12h5M24 16h5M24 20h5" />
          </g>
        </svg>
        <span>MCU Playground</span>
        <span className="brand-sub">{exercise ? exercise.title : 'Sandbox'}</span>
      </div>

      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => void actions.buildAndRun()} disabled={build === 'building'} title="Compile and start (Ctrl+Enter)">
          <Icon name="play" /> Build and run
        </button>
        {running ? (
          <button className="btn" onClick={actions.pause} title="Freeze the simulation">
            <Icon name="pause" /> Pause
          </button>
        ) : (
          <button className="btn" onClick={actions.resume} disabled={!loaded || frame?.state === 'halted'} title="Continue">
            <Icon name="play" /> Resume
          </button>
        )}
        <button className="btn" onClick={actions.resetChip} disabled={!loaded} title="Press the chip's reset button">
          <Icon name="reset" /> Reset
        </button>
        <label className="select" title="Simulation speed">
          <span>Speed</span>
          <select value={speed} onChange={(e) => actions.setSpeed(Number(e.target.value))}>
            <option value={0.1}>0.1x slow motion</option>
            <option value={0.5}>0.5x</option>
            <option value={1}>1x real time</option>
            <option value={4}>4x</option>
            <option value={0}>As fast as possible</option>
          </select>
        </label>
        <label className="select" title="Compiler optimisation level. -O2 is what release builds use and exposes missing-volatile bugs.">
          <span>Optimise</span>
          <select value={opt} onChange={(e) => actions.setOpt(e.target.value as OptLevel)}>
            <option value="O0">-O0 none</option>
            <option value="Og">-Og debug</option>
            <option value="O2">-O2 speed</option>
            <option value="Os">-Os size</option>
          </select>
        </label>
      </div>

      <div className="status">
        <StatusChip />
        {frame && (
          <>
            <span className="stat" title="Simulated time since power-on">
              {fmtTime(frame.time)}
            </span>
            <span className="stat" title="CPU clock (HCLK)">
              {fmtHz(frame.cpu.hclk)}
            </span>
            {frame.state === 'running' && (
              <span className="stat" title="Simulated seconds per real second">
                {frame.speed >= 10 ? frame.speed.toFixed(0) : frame.speed.toFixed(2)}x
              </span>
            )}
          </>
        )}
      </div>
    </header>
  );
}

export function Icon({ name }: { name: 'play' | 'pause' | 'reset' | 'check' | 'cross' | 'dot' | 'plus' | 'chevron' | 'eye' }) {
  const paths: Record<string, React.ReactNode> = {
    play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
    pause: <path d="M4.5 3.5v9M11.5 3.5v9" strokeWidth="2.2" />,
    reset: <path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8" />,
    check: <path d="M3 8.5l3.2 3.2L13 4.8" />,
    cross: <path d="M4 4l8 8M12 4l-8 8" />,
    dot: <circle cx="8" cy="8" r="3" />,
    plus: <path d="M8 3v10M3 8h10" />,
    chevron: <path d="M6 3.5L10.5 8 6 12.5" />,
    eye: (
      <>
        <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
        <circle cx="8" cy="8" r="2" />
      </>
    ),
  };
  return (
    <svg className="icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function Dock() {
  const dock = useApp((s) => s.dock);
  const problems = useApp((s) => s.hints.length + (s.fault ? 1 : 0));
  const buildIssues = useApp((s) => s.build.diagnostics.filter((d) => d.severity !== 'note').length);
  const buildFailed = useApp((s) => s.build.status === 'error');
  const tabs: Array<[typeof dock, string, number]> = [
    ['serial', 'Serial console', 0],
    ['trace', 'Pin trace', 0],
    ['problems', 'Hints', problems],
    ['build', 'Build output', buildIssues],
  ];
  return (
    <section className="dock">
      <div className="dock-tabs" role="tablist">
        {tabs.map(([id, label, count]) => (
          <button key={id} role="tab" aria-selected={dock === id} className={`dock-tab${dock === id ? ' active' : ''}`} onClick={() => actions.setDock(id)}>
            {label}
            {count > 0 && <span className={`badge${id === 'build' && buildFailed ? ' badge-danger' : id === 'problems' ? ' badge-warn' : ''}`}>{count}</span>}
          </button>
        ))}
      </div>
      <div className="dock-body">
        {dock === 'serial' && <SerialPanel />}
        {dock === 'trace' && <TracePanel />}
        {dock === 'problems' && <ProblemsPanel />}
        {dock === 'build' && <BuildPanel />}
      </div>
    </section>
  );
}

export function App() {
  const ready = useApp((s) => s.ready);
  const toolchain = useApp((s) => s.toolchain);
  const error = useApp((s) => s.error);
  const exercise = useApp((s) => currentExercise(s));
  const [started] = useState(() => {
    void actions.init();
    return true;
  });

  if (!started || !ready) return <div className="loading">Starting…</div>;

  return (
    <div className="app">
      <TopBar />
      {!toolchain && (
        <div className="banner banner-danger">
          The ARM compiler is not installed. Run <code>npm run toolchain</code> in the project folder, then reload.
        </div>
      )}
      {error && (
        <div className="banner banner-danger">
          <span>{error}</span>
          <button className="btn btn-small" onClick={actions.dismissError}>
            Dismiss
          </button>
        </div>
      )}
      <div className="main">
        <ExerciseList />
        <div className="center">
          {exercise && <ExerciseBrief exercise={exercise} />}
          <FileTabs />
          <CodeEditor />
          <Dock />
        </div>
        <div className="right">
          <BoardPanel />
          {exercise && <ChecksPanel exercise={exercise} />}
        </div>
      </div>
    </div>
  );
}
