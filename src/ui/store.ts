/**
 * Application state and controller: project files, building, the simulation
 * worker, exercise checks. React components read the state through useApp().
 */
import { useSyncExternalStore } from 'react';
import type { DeviceSpec } from '../board/devices';
import { EXERCISES, exerciseById, type CheckResult, type Exercise } from '../exercises';
import type { FaultReport, Frame, FromWorker, HintReport, ToWorker } from '../worker/protocol';
import { SANDBOX_MAIN } from './sandbox';

export type OptLevel = 'O0' | 'Og' | 'O1' | 'O2' | 'Os';
export type BoardView = 'devices' | 'schematic' | '3d';

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

export interface SourceLoc {
  func: string;
  file: string;
  line: number;
}

export interface BuildState {
  status: 'idle' | 'building' | 'ok' | 'error';
  log: string;
  diagnostics: Diagnostic[];
  size: { text: number; data: number; bss: number } | null;
  buildId: string | null;
  /** Project the last successful build belongs to. */
  projectId: string | null;
}

export interface CheckState {
  status: 'idle' | 'running' | 'done' | 'build-error';
  results: CheckResult[];
}

export interface AppState {
  ready: boolean;
  toolchain: boolean;
  projectId: string;
  projects: Record<string, Record<string, string>>;
  activeFile: string;
  /** Read-only file currently shown instead of a project file (support file or solution). */
  viewing: { name: string; content: string; label: string } | null;
  firmware: Record<string, string>;
  opt: OptLevel;
  speed: number;
  build: BuildState;
  frame: Frame | null;
  specs: DeviceSpec[];
  serial: string;
  hints: HintReport[];
  fault: FaultReport | null;
  locations: Record<number, SourceLoc>;
  watch: string[];
  checks: Record<string, CheckState>;
  passed: Record<string, boolean>;
  boardView: BoardView;
  details: boolean;
  dock: 'serial' | 'trace' | 'problems' | 'build';
  /** Pin highlighted across the views (hover). */
  hoverPin: string | null;
  /** Request for the editor to jump to a location. */
  reveal: { file: string; line: number; nonce: number } | null;
  error: string | null;
}

const SANDBOX = 'sandbox';

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: preferences are simply not remembered */
  }
}

const prefs = loadJson<Partial<Pick<AppState, 'projectId' | 'opt' | 'boardView' | 'details' | 'watch'>>>('mcu-prefs', {});

let state: AppState = {
  ready: false,
  toolchain: true,
  projectId: prefs.projectId && (prefs.projectId === SANDBOX || exerciseById(prefs.projectId)) ? prefs.projectId : SANDBOX,
  projects: {},
  activeFile: 'main.c',
  viewing: null,
  firmware: {},
  opt: prefs.opt ?? 'Og',
  speed: 1,
  build: { status: 'idle', log: '', diagnostics: [], size: null, buildId: null, projectId: null },
  frame: null,
  specs: [],
  serial: '',
  hints: [],
  fault: null,
  locations: {},
  watch: prefs.watch ?? ['PA5'],
  checks: {},
  passed: loadJson<Record<string, boolean>>('mcu-passed', {}),
  boardView: prefs.boardView ?? 'devices',
  details: prefs.details ?? false,
  dock: 'serial',
  hoverPin: null,
  reveal: null,
  error: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getState(): AppState {
  return state;
}
export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

function savePrefs(): void {
  saveJson('mcu-prefs', {
    projectId: state.projectId,
    opt: state.opt,
    boardView: state.boardView,
    details: state.details,
    watch: state.watch,
  });
}

// ------------------------------------------------------------------ traces

/** Rolling per-pin waveform buffers, kept outside React and drawn on a canvas. */
export class TraceStore {
  readonly data = new Map<string, { t: number[]; v: number[] }>();
  now = 0;
  private maxPoints = 60_000;

  clear(): void {
    this.data.clear();
    this.now = 0;
  }

  append(pin: string, t: number[], v: number[]): void {
    let d = this.data.get(pin);
    if (!d) this.data.set(pin, (d = { t: [], v: [] }));
    for (let i = 0; i < t.length; i++) {
      const n = d.t.length;
      if (n > 0 && t[i] === d.t[n - 1] && v[i] === d.v[n - 1]) continue;
      d.t.push(t[i]);
      d.v.push(v[i]);
    }
    if (d.t.length > this.maxPoints) {
      d.t = d.t.slice(-this.maxPoints / 2);
      d.v = d.v.slice(-this.maxPoints / 2);
    }
  }
}

export const traces = new TraceStore();

// --------------------------------------------------------------- controller

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

interface CompileResponse {
  ok: boolean;
  buildId: string;
  elf: string | null;
  diagnostics: Diagnostic[];
  log: string;
  size: BuildState['size'];
}

let worker: Worker | null = null;
let checkWorker: Worker | null = null;
let checkToken = 0;
const saveTimers = new Map<string, number>();

function send(msg: ToWorker, transfer: Transferable[] = []): void {
  worker?.postMessage(msg, transfer);
}

function onWorkerMessage(msg: FromWorker): void {
  if (msg.type === 'frame') {
    for (const [pin, chunk] of Object.entries(msg.traces)) traces.append(pin, chunk.t, chunk.v);
    traces.now = msg.time;
    const patch: Partial<AppState> = { frame: msg };
    if (msg.specs) patch.specs = msg.specs;
    if (msg.serialReset) patch.serial = msg.serial;
    else if (msg.serial) patch.serial = (state.serial + msg.serial).slice(-60_000);
    if (msg.hints.length) {
      patch.hints = [...state.hints, ...msg.hints];
      void resolveLocations(msg.hints.map((h) => h.pc));
    }
    if (msg.fault !== state.fault && (msg.fault || state.fault)) {
      patch.fault = msg.fault;
      if (msg.fault) {
        patch.dock = 'problems';
        void resolveLocations([msg.fault.pc, msg.fault.lr & ~1]);
      }
    }
    set(patch);
  } else if (msg.type === 'error') {
    set({ error: msg.message });
  }
}

async function resolveLocations(addrs: number[]): Promise<void> {
  const buildId = state.build.buildId;
  const need = addrs.filter((a) => a > 0 && !(a in state.locations));
  if (!buildId || need.length === 0) return;
  try {
    const locs = await api<Array<SourceLoc & { addr: number }>>('/api/addr2line', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId, addrs: need }),
    });
    const merged = { ...state.locations };
    for (const l of locs) merged[l.addr] = { func: l.func, file: l.file, line: l.line };
    set({ locations: merged });
  } catch {
    /* source locations are a nicety */
  }
}

export function currentExercise(s: AppState = state): Exercise | null {
  return s.projectId === SANDBOX ? null : (exerciseById(s.projectId) ?? null);
}

function defaultFiles(projectId: string): Record<string, string> {
  const ex = exerciseById(projectId);
  return ex ? { ...ex.starter } : { 'main.c': SANDBOX_MAIN };
}

/** Files of the current project as the user sees them (edited or default). */
export function projectFiles(s: AppState = state): Record<string, string> {
  return s.projects[s.projectId] ?? defaultFiles(s.projectId);
}

function scheduleSave(projectId: string): void {
  const prev = saveTimers.get(projectId);
  if (prev) window.clearTimeout(prev);
  saveTimers.set(
    projectId,
    window.setTimeout(() => {
      saveTimers.delete(projectId);
      const files = state.projects[projectId];
      if (!files) return;
      void fetch(`/api/workspace/${projectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      }).catch(() => {});
    }, 500),
  );
}

async function compile(files: Record<string, string>, opt: OptLevel): Promise<CompileResponse> {
  return api<CompileResponse>('/api/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: Object.entries(files).map(([name, content]) => ({ name, content })), opt }),
  });
}

export const actions = {
  async init(): Promise<void> {
    if (worker) return;
    worker = new Worker(new URL('../worker/simWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<FromWorker>) => onWorkerMessage(ev.data);
    worker.onerror = (ev) => set({ error: ev.message });
    send({ type: 'watch', pins: state.watch });
    try {
      const [status, projects, firmware] = await Promise.all([
        api<{ toolchain: boolean }>('/api/status'),
        api<Record<string, Record<string, string>>>('/api/workspace'),
        api<Record<string, string>>('/api/firmware'),
      ]);
      const cleaned: Record<string, Record<string, string>> = {};
      for (const [id, files] of Object.entries(projects)) if (Object.keys(files).length) cleaned[id] = files;
      set({ ready: true, toolchain: status.toolchain, projects: cleaned, firmware });
    } catch (e) {
      set({ ready: true, error: `Could not reach the local dev server API: ${e instanceof Error ? e.message : e}` });
    }
    const files = projectFiles();
    set({ activeFile: Object.keys(files)[0] ?? 'main.c' });
  },

  selectProject(projectId: string): void {
    if (projectId === state.projectId) return;
    send({ type: 'pause' });
    traces.clear();
    set({
      projectId,
      viewing: null,
      build: { status: 'idle', log: '', diagnostics: [], size: null, buildId: null, projectId: null },
      frame: null,
      specs: [],
      serial: '',
      hints: [],
      fault: null,
      locations: {},
    });
    set({ activeFile: Object.keys(projectFiles())[0] ?? 'main.c' });
    savePrefs();
  },

  openFile(name: string): void {
    set({ activeFile: name, viewing: null });
  },

  viewReadOnly(name: string, content: string, label: string): void {
    set({ viewing: { name, content, label } });
  },

  editFile(name: string, content: string): void {
    const files = { ...projectFiles(), [name]: content };
    set({ projects: { ...state.projects, [state.projectId]: files } });
    scheduleSave(state.projectId);
  },

  addFile(name: string, content = ''): string | null {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,60}\.(c|h|ld|s|S)$/.test(name)) {
      return 'Use a name like sensors.c or config.h (letters, digits, _ and -).';
    }
    const files = projectFiles();
    if (name in files) return 'A file with that name already exists.';
    set({ projects: { ...state.projects, [state.projectId]: { ...files, [name]: content } }, activeFile: name, viewing: null });
    scheduleSave(state.projectId);
    return null;
  },

  removeFile(name: string): void {
    const files = { ...projectFiles() };
    delete files[name];
    set({
      projects: { ...state.projects, [state.projectId]: files },
      activeFile: state.activeFile === name ? (Object.keys(files)[0] ?? '') : state.activeFile,
    });
    scheduleSave(state.projectId);
  },

  /** Throw away the user's edits and restore the starter files. */
  resetProject(): void {
    const files = defaultFiles(state.projectId);
    set({ projects: { ...state.projects, [state.projectId]: files }, activeFile: Object.keys(files)[0], viewing: null });
    scheduleSave(state.projectId);
  },

  async buildAndRun(): Promise<void> {
    if (state.build.status === 'building') return;
    const ex = currentExercise();
    const projectId = state.projectId;
    set({ build: { ...state.build, status: 'building', log: '', diagnostics: [] } });
    try {
      const res = await compile({ ...ex?.support, ...projectFiles() }, state.opt);
      if (state.projectId !== projectId) return;
      if (!res.ok || !res.elf) {
        set({
          build: { status: 'error', log: res.log, diagnostics: res.diagnostics, size: null, buildId: null, projectId },
          dock: 'build',
        });
        return;
      }
      traces.clear();
      set({
        build: { status: 'ok', log: res.log, diagnostics: res.diagnostics, size: res.size, buildId: res.buildId, projectId },
        hints: [],
        fault: null,
        locations: {},
        serial: '',
        dock: state.dock === 'build' ? 'serial' : state.dock,
      });
      const elf = base64ToBuffer(res.elf);
      send({ type: 'watch', pins: state.watch });
      send({ type: 'load', elf, devices: ex ? ex.devices : undefined, deviceOptions: ex?.deviceOptions, autorun: true }, [elf]);
      send({ type: 'speed', value: state.speed });
    } catch (e) {
      set({ build: { ...state.build, status: 'error', log: String(e) }, dock: 'build' });
    }
  },

  async runChecks(): Promise<void> {
    const ex = currentExercise();
    if (!ex || state.checks[ex.id]?.status === 'running') return;
    const setCheck = (c: CheckState) => set({ checks: { ...state.checks, [ex.id]: c } });
    setCheck({ status: 'running', results: [] });
    try {
      const res = await compile({ ...ex.support, ...projectFiles() }, ex.opt ?? state.opt);
      if (!res.ok || !res.elf) {
        set({
          build: { status: 'error', log: res.log, diagnostics: res.diagnostics, size: null, buildId: null, projectId: ex.id },
          dock: 'build',
        });
        setCheck({ status: 'build-error', results: [] });
        return;
      }
      if (!checkWorker) {
        checkWorker = new Worker(new URL('../worker/simWorker.ts', import.meta.url), { type: 'module' });
        checkWorker.onmessage = (ev: MessageEvent<FromWorker>) => {
          const msg = ev.data;
          if (msg.type !== 'checkResult' || msg.token !== checkToken) return;
          const allPass = msg.results.length > 0 && msg.results.every((r) => r.pass);
          const passed = { ...state.passed, [msg.exerciseId]: allPass || !!state.passed[msg.exerciseId] };
          saveJson('mcu-passed', passed);
          set({ checks: { ...state.checks, [msg.exerciseId]: { status: 'done', results: msg.results } }, passed });
        };
      }
      const elf = base64ToBuffer(res.elf);
      checkWorker.postMessage({ type: 'check', exerciseId: ex.id, elf, token: ++checkToken } satisfies ToWorker, [elf]);
    } catch (e) {
      setCheck({ status: 'done', results: [{ name: 'Checks', pass: false, detail: String(e) }] });
    }
  },

  pause: () => send({ type: 'pause' }),
  resume: () => send({ type: 'run' }),
  resetChip: () => {
    set({ fault: null });
    send({ type: 'reset' });
  },
  setSpeed(value: number): void {
    set({ speed: value });
    send({ type: 'speed', value });
  },
  setOpt(opt: OptLevel): void {
    set({ opt });
    savePrefs();
  },
  input: (device: string, name: string, value: number) => send({ type: 'input', device, name, value }),
  sendSerial: (text: string) => send({ type: 'serial', text }),
  toggleWatch(pin: string): void {
    const watch = state.watch.includes(pin) ? state.watch.filter((p) => p !== pin) : [...state.watch, pin].slice(-8);
    set({ watch, dock: 'trace' });
    send({ type: 'watch', pins: watch });
    savePrefs();
  },
  setBoardView(boardView: BoardView): void {
    set({ boardView });
    savePrefs();
  },
  setDetails(details: boolean): void {
    set({ details });
    savePrefs();
  },
  setDock: (dock: AppState['dock']) => set({ dock }),
  setHoverPin: (pin: string | null) => {
    if (pin !== state.hoverPin) set({ hoverPin: pin });
  },
  reveal(file: string, line: number): void {
    const files = projectFiles();
    if (file in files) set({ activeFile: file, viewing: null, reveal: { file, line, nonce: Date.now() } });
    else if (file in state.firmware) {
      set({ viewing: { name: file, content: state.firmware[file], label: 'chip support file' }, reveal: { file, line, nonce: Date.now() } });
    }
  },
  clearSerial: () => set({ serial: '' }),
  dismissError: () => set({ error: null }),
};

export { EXERCISES, SANDBOX };
