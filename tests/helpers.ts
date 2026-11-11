import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compile, OptLevel, ROOT, SourceFile } from '../server/toolchain';
import { Bus, FLASH_BASE, Peripheral, RAM_BASE } from '../src/emu/bus';
import { Clock } from '../src/emu/clock';
import { Cpu } from '../src/emu/cpu';
import { loadImage, parseElf } from '../src/emu/elf';

export const C_DIR = path.join(ROOT, 'tests', 'c');

export async function readC(name: string): Promise<SourceFile> {
  return { name, content: await readFile(path.join(C_DIR, name), 'utf8') };
}

/** Build for the emulated chip, with stdout routed to the debug port at 0x4000F000. */
export async function buildBare(files: SourceFile[], opt: OptLevel = 'Og', extraFlags: string[] = []): Promise<Uint8Array> {
  const sys = await readC('test_syscalls.c');
  const res = await compile([...files, { name: 'syscalls.c', content: sys.content }], { opt, extraFlags });
  if (!res.ok || !res.elf) throw new Error('ARM build failed:\n' + res.log);
  return res.elf;
}

export interface BareRun {
  out: string;
  cpu: Cpu;
  bus: Bus;
  clock: Clock;
}

/** Run an ELF on the bare CPU (no STM32 peripherals) until it exits or the cycle budget is used up. */
export function runBare(elf: Uint8Array, maxCycles = 4e9): BareRun {
  const bus = new Bus();
  const clock = new Clock();
  const cpu = new Cpu(bus, clock);
  const chars: number[] = [];
  const debugPort: Peripheral = {
    name: 'DEBUG',
    read32: () => 0,
    write32: (_off, value) => {
      chars.push(value & 0xff);
    },
    reset: () => {},
  };
  bus.map(0x4000f000, debugPort);
  const image = parseElf(elf);
  if (!loadImage(image, bus.flash, FLASH_BASE, bus.ram, RAM_BASE)) throw new Error('image does not fit');
  cpu.onFault = () => {
    cpu.stopRequested = true;
  };
  cpu.reset();
  cpu.run(maxCycles);
  return { out: Buffer.from(chars).toString('latin1'), cpu, bus, clock };
}

function exec(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) + (err ? err.message : '') });
    });
  });
}

/** Compile and run a C program natively with the host gcc; returns its stdout. */
export async function runNative(files: SourceFile[], flags: string[] = []): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcu-native-'));
  for (const f of files) await writeFile(path.join(dir, f.name), f.content);
  const exe = path.join(dir, process.platform === 'win32' ? 'prog.exe' : 'prog');
  const build = await exec('gcc', ['-std=gnu11', '-O1', '-ffp-contract=off', ...flags, ...files.map((f) => f.name), '-o', exe], dir);
  if (build.code !== 0) throw new Error('native build failed:\n' + build.stderr);
  const run = await exec(exe, [], dir);
  if (run.code !== 0) throw new Error('native run failed:\n' + run.stderr);
  return run.stdout.replace(/\r\n/g, '\n');
}

export function hostGccAvailable(): Promise<boolean> {
  return exec('gcc', ['--version'], ROOT).then((r) => r.code === 0);
}
