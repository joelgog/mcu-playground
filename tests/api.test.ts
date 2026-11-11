/** The local API (compile, debug info, workspace) exercised through the real Vite middleware. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { ROOT } from '../server/toolchain';
import { parseElf } from '../src/emu/elf';

let vite: ViteDevServer;
let server: http.Server;
let base = '';
const PROJECT = 'zz-api-test';

beforeAll(async () => {
  vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  server = http.createServer(vite.middlewares);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await vite.close();
  await rm(path.join(ROOT, 'workspace', PROJECT), { recursive: true, force: true });
});

const post = (url: string, body: unknown, method = 'POST') =>
  fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

describe('local API', () => {
  it('reports the toolchain and serves the chip support files', async () => {
    expect(await fetch(`${base}/api/status`).then((r) => r.json())).toEqual({ toolchain: true });
    const fw = (await fetch(`${base}/api/firmware`).then((r) => r.json())) as Record<string, string>;
    expect(Object.keys(fw).sort()).toEqual(['linker.ld', 'startup.c', 'syscalls.c', 'system_stm32f0xx.c']);
    expect(fw['startup.c']).toContain('Reset_Handler');
  });

  it('compiles a program and maps addresses back to source lines', async () => {
    const res = await post('/api/compile', {
      files: [{ name: 'main.c', content: '#include "stm32f0xx.h"\nint main(void)\n{\n    for (;;) {\n    }\n}\n' }],
      opt: 'Og',
    });
    expect(res.ok).toBe(true);
    expect(res.diagnostics).toEqual([]);
    expect(res.size.text).toBeGreaterThan(100);
    const image = parseElf(new Uint8Array(Buffer.from(res.elf, 'base64')));
    const main = image.symbols.find((s) => s.name === 'main')!;
    const locs = await post('/api/addr2line', { buildId: res.buildId, addrs: [main.addr & ~1] });
    expect(locs[0].func).toBe('main');
    expect(locs[0].file).toBe('main.c');
    expect(locs[0].line).toBeGreaterThanOrEqual(2);
    const dis = (await fetch(`${base}/api/disasm?build=${res.buildId}`).then((r) => r.json())) as { text: string };
    expect(dis.text).toContain('<main>:');
  });

  it('returns structured diagnostics for a compile error and a warning', async () => {
    const res = await post('/api/compile', {
      files: [{ name: 'main.c', content: 'int main(void)\n{\n    int unused;\n    return missing;\n}\n' }],
    });
    expect(res.ok).toBe(false);
    expect(res.elf).toBeNull();
    const err = res.diagnostics.find((d: { severity: string }) => d.severity === 'error');
    expect(err).toMatchObject({ file: 'main.c', line: 4 });
    expect(err.message).toMatch(/missing/);
    expect(res.diagnostics.some((d: { severity: string; line: number }) => d.severity === 'warning' && d.line === 3)).toBe(true);
  });

  it('rejects unsafe file names', async () => {
    const res = await post('/api/compile', { files: [{ name: '../evil.c', content: '' }] });
    expect(res.ok).toBe(false);
    expect(res.log).toMatch(/Invalid file name/);
  });

  it('saves, lists and prunes workspace files', async () => {
    await post(`/api/workspace/${PROJECT}`, { files: { 'main.c': 'int a;', 'util.h': '#define X 1' } }, 'PUT');
    let all = (await fetch(`${base}/api/workspace`).then((r) => r.json())) as Record<string, Record<string, string>>;
    expect(all[PROJECT]).toEqual({ 'main.c': 'int a;', 'util.h': '#define X 1' });
    await post(`/api/workspace/${PROJECT}`, { files: { 'main.c': 'int b;' } }, 'PUT');
    all = (await fetch(`${base}/api/workspace`).then((r) => r.json())) as Record<string, Record<string, string>>;
    expect(all[PROJECT]).toEqual({ 'main.c': 'int b;' });
    const bad = await fetch(`${base}/api/workspace/..%2Fevil`, { method: 'PUT', body: '{"files":{}}' });
    expect(bad.status).toBe(400);
  });
});
