/**
 * Wrapper around arm-none-eabi-gcc: compiles the user's C files together with
 * the firmware support files (startup code, linker script, syscalls) into an ELF.
 * Used by the dev-server API and by the test suite.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIRMWARE_DIR = path.join(ROOT, 'firmware');
const BIN_DIR = path.join(ROOT, 'xpacks', '@xpack-dev-tools', 'arm-none-eabi-gcc', '.content', 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';
const BUILD_ROOT = path.join(os.tmpdir(), 'mcu-playground-builds');

/** Support files that are always part of a build; a user file with the same name replaces it. */
export const FIRMWARE_SOURCES = ['startup.c', 'system_stm32f0xx.c', 'syscalls.c'];
export const LINKER_SCRIPT = 'linker.ld';

export type OptLevel = 'O0' | 'Og' | 'O1' | 'O2' | 'Os';

export interface SourceFile {
  name: string;
  content: string;
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

export interface CompileResult {
  ok: boolean;
  buildId: string;
  elf?: Uint8Array;
  diagnostics: Diagnostic[];
  /** Raw compiler/linker output. */
  log: string;
  size?: { text: number; data: number; bss: number };
}

export function tool(name: string): string {
  return path.join(BIN_DIR, `arm-none-eabi-${name}${EXE}`);
}

export function toolchainInstalled(): boolean {
  return existsSync(tool('gcc'));
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: err && !stderr ? String(err.message) : String(stderr) });
    });
  });
}

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(c|h|ld|s|S)$/;

export function parseDiagnostics(text: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /^(?:\.[\\/])?([^\s:][^:\n]*?):(\d+):(?:(\d+):)?\s+(fatal error|error|warning|note):\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      file: path.basename(m[1]),
      line: Number(m[2]),
      column: m[3] ? Number(m[3]) : 1,
      severity: m[4] === 'fatal error' ? 'error' : (m[4] as Diagnostic['severity']),
      message: m[5].trim(),
    });
  }
  return out;
}

let buildCounter = 0;

export async function compile(
  files: SourceFile[],
  opts: { opt?: OptLevel; defines?: string[]; extraFlags?: string[] } = {},
): Promise<CompileResult> {
  const buildId = `${Date.now().toString(36)}-${(buildCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(BUILD_ROOT, buildId);
  if (!toolchainInstalled()) {
    return {
      ok: false, buildId, diagnostics: [],
      log: 'The ARM compiler is not installed. Run "npm run toolchain" in the project folder.',
    };
  }
  await mkdir(dir, { recursive: true });

  for (const f of files) {
    if (!SAFE_NAME.test(f.name)) {
      return { ok: false, buildId, diagnostics: [], log: `Invalid file name: ${f.name}` };
    }
    await writeFile(path.join(dir, f.name), f.content);
  }
  const userNames = new Set(files.map((f) => f.name));
  const sources = files.filter((f) => /\.(c|s|S)$/.test(f.name)).map((f) => f.name);
  for (const fw of FIRMWARE_SOURCES) {
    if (!userNames.has(fw)) sources.push(path.join(FIRMWARE_DIR, fw));
  }
  const ld = userNames.has(LINKER_SCRIPT) ? LINKER_SCRIPT : path.join(FIRMWARE_DIR, LINKER_SCRIPT);

  const args = [
    '-mcpu=cortex-m0', '-mthumb', '-std=gnu11',
    `-${opts.opt ?? 'Og'}`, '-g3',
    '-Wall', '-Wextra',
    '-ffunction-sections', '-fdata-sections',
    '-fdiagnostics-color=never', '-fno-diagnostics-show-caret',
    '-DSTM32F072xB',
    ...(opts.defines ?? []).map((d) => `-D${d}`),
    '-I', '.', '-I', path.join(FIRMWARE_DIR, 'cmsis'),
    ...(opts.extraFlags ?? []),
    ...sources,
    '-T', ld,
    '-nostartfiles', '--specs=nano.specs',
    '-Wl,--gc-sections', '-Wl,--no-warn-rwx-segments',
    '-Wl,-Map=firmware.map',
    '-o', 'firmware.elf',
  ];
  const res = await run(tool('gcc'), args, dir);
  const log = (res.stderr + res.stdout).replaceAll(dir + path.sep, '').replaceAll(FIRMWARE_DIR + path.sep, '');
  const diagnostics = parseDiagnostics(log);
  if (res.code !== 0 || !existsSync(path.join(dir, 'firmware.elf'))) {
    return { ok: false, buildId, diagnostics, log };
  }
  const elf = new Uint8Array(await readFile(path.join(dir, 'firmware.elf')));
  let size: CompileResult['size'];
  const sz = await run(tool('size'), ['firmware.elf'], dir);
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/m.exec(sz.stdout);
  if (m) size = { text: Number(m[1]), data: Number(m[2]), bss: Number(m[3]) };
  void pruneBuilds(buildId);
  return { ok: true, buildId, elf, diagnostics, log, size };
}

const SAFE_ID = /^[a-z0-9-]+$/;

export interface SourceLocation {
  addr: number;
  func: string;
  file: string;
  line: number;
}

/** Map code addresses back to function / file / line using the build's debug info. */
export async function addr2line(buildId: string, addrs: number[]): Promise<SourceLocation[]> {
  if (!SAFE_ID.test(buildId)) return [];
  const dir = path.join(BUILD_ROOT, buildId);
  if (!existsSync(path.join(dir, 'firmware.elf'))) return [];
  const res = await run(tool('addr2line'), ['-e', 'firmware.elf', '-f', '-C', ...addrs.map((a) => '0x' + (a >>> 0).toString(16))], dir);
  const lines = res.stdout.split(/\r?\n/);
  return addrs.map((addr, i) => {
    const func = lines[i * 2] ?? '??';
    const loc = lines[i * 2 + 1] ?? '??:0';
    const m = /^(.*):(\d+|\?)(?: \(discriminator \d+\))?$/.exec(loc);
    return { addr, func, file: m ? path.basename(m[1]) : '??', line: m && m[2] !== '?' ? Number(m[2]) : 0 };
  });
}

/** Annotated disassembly of the build (source lines interleaved with instructions). */
export async function disassemble(buildId: string): Promise<string> {
  if (!SAFE_ID.test(buildId)) return '';
  const dir = path.join(BUILD_ROOT, buildId);
  if (!existsSync(path.join(dir, 'firmware.elf'))) return '';
  const res = await run(tool('objdump'), ['-d', '-S', '--no-show-raw-insn', 'firmware.elf'], dir);
  return res.stdout.replaceAll(dir + path.sep, '').replaceAll(FIRMWARE_DIR + path.sep, '');
}

/** Keep only the most recent builds on disk. */
async function pruneBuilds(keep: string): Promise<void> {
  try {
    const entries = (await readdir(BUILD_ROOT)).filter((e) => e !== keep).sort();
    const excess = entries.slice(0, Math.max(0, entries.length - 12));
    await Promise.all(excess.map((e) => rm(path.join(BUILD_ROOT, e), { recursive: true, force: true })));
  } catch {
    /* best effort */
  }
}
