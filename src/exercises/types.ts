import type { Board } from '../board/board';
import type { Net } from '../board/net';
import type { Mcu } from '../emu/mcu';

export interface CheckResult {
  name: string;
  pass: boolean;
  /** What was observed (shown next to the check). */
  detail: string;
}

export interface CheckContext {
  mcu: Mcu;
  board: Board;
  /** Advance the simulation by this many seconds. */
  run(sec: number): void;
  /** Press a button, hold it for holdMs, release it and let the contacts settle. */
  press(buttonId: string, holdMs?: number): void;
  /** Start recording a pin and return its net. */
  trace(pin: string): Net;
  /** Read a global variable of the firmware (null if it does not exist). */
  global(name: string, size?: number): number | null;
  /** Text received by the serial console so far. */
  serial(): string;
  /** Add a result line. */
  expect(name: string, pass: boolean, detail: string): void;
  /** True if the simulator raised a hint with this id prefix. */
  hinted(idPrefix: string): boolean;
}

export type OptLevel = 'O0' | 'Og' | 'O1' | 'O2' | 'Os';

export interface Exercise {
  id: string;
  title: string;
  /** One line for the exercise list. */
  summary: string;
  /** The task, in two or three plain sentences. Paragraphs separated by blank lines; `code` in backticks. */
  brief: string;
  /** The technical background: what an interviewer is looking for. */
  background: string;
  /** Ids of the board devices fitted for this exercise. */
  devices: string[];
  deviceOptions?: Record<string, Record<string, number | string | boolean>>;
  /** Files the user starts with (name -> content). The first one opens in the editor. */
  starter: Record<string, string>;
  /** Reference solution (same file names as the starter). */
  solution: Record<string, string>;
  /** Read-only support files compiled together with the user's code. */
  support?: Record<string, string>;
  /** Optimisation level the checks are built with (default: whatever the user selected). */
  opt?: OptLevel;
  check(ctx: CheckContext): void;
}
