/// <reference lib="webworker" />
/**
 * Simulation worker: owns the simulated MCU and board, runs them in real time
 * (or as fast as possible) and reports a snapshot to the UI about 30 times a second.
 */
import { Board } from '../board/board';
import { Mcu } from '../emu/mcu';
import { exerciseById } from '../exercises';
import { runCheck } from '../exercises/runner';
import type { FaultReport, Frame, FromWorker, HintReport, SimState, ToWorker, TraceChunk } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

let mcu: Mcu | null = null;
let board: Board | null = null;
let running = false;
let speed = 1;
let watch: string[] = [];
let serial = '';
let serialReset = false;
let hints: HintReport[] = [];
let fault: FaultReport | null = null;
let specsPending = false;
let lastWall = 0;
let simAtLastFrame = 0;
let wallAtLastFrame = 0;
let sleepAtLastFrame = 0;
let cyclesAtLastFrame = 0;
let speedAvg = 0;
let frameDue = 0;
let dirty = true;

function load(msg: Extract<ToWorker, { type: 'load' }>): void {
  const m = new Mcu();
  const b = new Board(m, msg.devices, msg.deviceOptions);
  hints = [];
  fault = null;
  serial = '';
  serialReset = true;
  m.onHint = (h) => hints.push({ ...h, func: m.functionAt(h.pc) });
  m.onFault = (f) => {
    fault = { kind: f.kind, pc: f.pc, lr: f.lr, sp: f.sp, addr: f.addr, message: f.message, lockup: f.lockup, func: m.functionAt(f.pc) };
    m.cpu.stopRequested = true;
    running = false;
  };
  m.onReset = (cause) => {
    if (cause === 'power') return;
    const why = cause === 'iwdg' ? 'watchdog timeout' : cause === 'software' ? 'software reset' : 'reset button';
    serial += `\n[chip reset: ${why}]\n`;
  };
  if (b.console) b.console.onText = (chunk) => (serial += chunk);
  m.load(new Uint8Array(msg.elf));
  mcu = m;
  board = b;
  applyWatch();
  specsPending = true;
  running = msg.autorun;
  lastWall = performance.now();
  simAtLastFrame = 0;
  wallAtLastFrame = lastWall;
  sleepAtLastFrame = 0;
  cyclesAtLastFrame = 0;
  speedAvg = 0;
  dirty = true;
}

function applyWatch(): void {
  if (!mcu) return;
  for (const pin of watch) {
    const net = mcu.nets.get(pin);
    if (net && !net.tracing) net.startTrace();
  }
}

function state(): SimState {
  if (!mcu) return 'empty';
  if (mcu.cpu.halted) return 'halted';
  return running ? 'running' : 'paused';
}

function advance(): void {
  if (!mcu || !running) return;
  const now = performance.now();
  const dtWall = Math.min(now - lastWall, 100) / 1000;
  lastWall = now;
  let budget = speed > 0 ? dtWall * speed : Infinity;
  const deadline = now + 11;
  const slice = speed > 0 ? Math.min(0.002, Math.max(0.0002, 0.002 * speed)) : 0.005;
  while (budget > 1e-9 && running) {
    const before = mcu.clock.seconds();
    mcu.runSeconds(Math.min(budget, slice));
    const did = mcu.clock.seconds() - before;
    budget -= did > 0 ? did : slice;
    if (mcu.cpu.halted) {
      running = false;
      break;
    }
    if (performance.now() >= deadline) break;
  }
  dirty = true;
}

function frame(): void {
  if (!mcu || !board) {
    return;
  }
  const now = performance.now();
  const simNow = mcu.clock.seconds();
  const wallDt = (now - wallAtLastFrame) / 1000;
  if (wallDt > 0) {
    const inst = (simNow - simAtLastFrame) / wallDt;
    speedAvg = speedAvg === 0 ? inst : speedAvg * 0.8 + inst * 0.2;
  }
  const dc = mcu.clock.cycles - cyclesAtLastFrame;
  const sleepFrac = dc > 0 ? (mcu.cpu.sleepCycles - sleepAtLastFrame) / dc : mcu.cpu.sleeping ? 1 : 0;
  simAtLastFrame = simNow;
  wallAtLastFrame = now;
  cyclesAtLastFrame = mcu.clock.cycles;
  sleepAtLastFrame = mcu.cpu.sleepCycles;

  const traces: Record<string, TraceChunk> = {};
  for (const pin of watch) {
    const net = mcu.nets.get(pin);
    if (!net || !net.tracing) continue;
    let t = net.traceT;
    let v = net.traceV;
    if (t.length > 6000) {
      t = t.slice(-6000);
      v = v.slice(-6000);
    }
    traces[pin] = { t, v };
    // keep the last point so the next chunk continues from the current level
    net.traceT = [simNow];
    net.traceV = [net.v];
  }

  const pc = mcu.cpu.pc >>> 0;
  const f: Frame = {
    type: 'frame',
    time: simNow,
    state: state(),
    haltReason: mcu.cpu.halted,
    speed: state() === 'running' ? speedAvg : 0,
    board: board.snapshot(),
    specs: specsPending ? board.specs : null,
    serial,
    serialReset,
    traces,
    hints,
    fault,
    cpu: {
      pc,
      func: mcu.functionAt(pc),
      sleeping: mcu.cpu.sleeping,
      sleepFrac,
      hclk: mcu.clock.hz,
      ipsr: mcu.cpu.ipsr,
      sp: mcu.cpu.r[13] >>> 0,
      stackLimit: mcu.stackLimit(),
    },
    resets: mcu.resetCount,
    lastReset: mcu.lastResetCause,
    timers: [...mcu.timers.values()].map((t) => t.describe(mcu!.clock.hz)),
  };
  specsPending = false;
  serial = '';
  serialReset = false;
  hints = [];
  post(f);
}

function tick(): void {
  try {
    advance();
    const now = performance.now();
    if (mcu && (now >= frameDue) && (running || dirty)) {
      frameDue = now + (running ? 30 : 120);
      dirty = false;
      frame();
    }
  } catch (e) {
    running = false;
    post({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
  setTimeout(tick, running ? 0 : 40);
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'load':
        load(msg);
        break;
      case 'run':
        if (mcu && !mcu.cpu.halted) {
          fault = null;
          running = true;
          lastWall = performance.now();
        } else if (mcu && mcu.cpu.halted === 'breakpoint') {
          mcu.cpu.halted = null;
          running = true;
          lastWall = performance.now();
        }
        dirty = true;
        break;
      case 'pause':
        running = false;
        dirty = true;
        break;
      case 'reset':
        if (mcu) {
          fault = null;
          mcu.reset('pin');
          running = true;
          lastWall = performance.now();
          dirty = true;
        }
        break;
      case 'speed':
        speed = msg.value;
        lastWall = performance.now();
        break;
      case 'input':
        board?.input(msg.device, msg.name, msg.value);
        dirty = true;
        frameDue = 0;
        break;
      case 'serial':
        board?.console?.send(msg.text);
        break;
      case 'watch':
        watch = msg.pins;
        applyWatch();
        dirty = true;
        break;
      case 'check': {
        const ex = exerciseById(msg.exerciseId);
        const results = ex
          ? runCheck(ex, new Uint8Array(msg.elf))
          : [{ name: 'Exercise', pass: false, detail: `unknown exercise ${msg.exerciseId}` }];
        post({ type: 'checkResult', exerciseId: msg.exerciseId, token: msg.token, results });
        break;
      }
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};

post({ type: 'ready' });
tick();
