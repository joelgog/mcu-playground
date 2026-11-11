/** Messages between the UI thread and the simulation worker. */
import type { BoardSnapshot } from '../board/board';
import type { DeviceSpec } from '../board/devices';
import type { CheckResult } from '../exercises/types';

export type ToWorker =
  | {
      type: 'load';
      elf: ArrayBuffer;
      /** Device ids to fit (undefined = full board). */
      devices?: string[];
      deviceOptions?: Record<string, Record<string, number | string | boolean>>;
      autorun: boolean;
    }
  | { type: 'run' }
  | { type: 'unload' }
  | { type: 'pause' }
  | { type: 'reset' }
  | { type: 'speed'; value: number }
  | { type: 'input'; device: string; name: string; value: number }
  | { type: 'serial'; text: string }
  | { type: 'watch'; pins: string[] }
  | { type: 'check'; exerciseId: string; elf: ArrayBuffer; token: number };

export type SimState = 'empty' | 'running' | 'paused' | 'halted';

export interface FaultReport {
  kind: string;
  pc: number;
  lr: number;
  sp: number;
  addr: number;
  message: string;
  lockup: boolean;
  func: string | null;
}

export interface HintReport {
  id: string;
  message: string;
  timeSec: number;
  pc: number;
  func: string | null;
}

export interface TraceChunk {
  t: number[];
  v: number[];
}

export interface Frame {
  type: 'frame';
  /** Simulated seconds since power-on. */
  time: number;
  state: SimState;
  /** Why the CPU halted (main returned, breakpoint, lockup). */
  haltReason: string | null;
  /** Simulated seconds per wall-clock second, recently. */
  speed: number;
  board: BoardSnapshot;
  /** Devices fitted on the board (sent on load). */
  specs: DeviceSpec[] | null;
  /** New serial console output since the last frame. */
  serial: string;
  /** True if the console should be cleared before appending (new program or reset). */
  serialReset: boolean;
  /** New trace points for the watched pins since the last frame. */
  traces: Record<string, TraceChunk>;
  hints: HintReport[];
  fault: FaultReport | null;
  cpu: {
    pc: number;
    func: string | null;
    sleeping: boolean;
    /** Fraction of recent time spent asleep in WFI. */
    sleepFrac: number;
    hclk: number;
    /** Active exception number (0 = thread mode). */
    ipsr: number;
    sp: number;
    stackLimit: number;
  };
  resets: number;
  lastReset: string;
  timers: string[];
}

export type FromWorker =
  | Frame
  | { type: 'ready' }
  | { type: 'checkResult'; exerciseId: string; token: number; results: CheckResult[] }
  | { type: 'error'; message: string };
