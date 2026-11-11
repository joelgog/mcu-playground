import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { FIRMWARE_DIR, ROOT, addr2line, compile, disassemble, toolchainInstalled, type OptLevel } from './server/toolchain.ts';

const WORKSPACE = path.join(ROOT, 'workspace');
const SAFE_PROJECT = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SAFE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,60}\.(c|h|ld|s|S)$/;
const FIRMWARE_FILES = ['startup.c', 'linker.ld', 'syscalls.c', 'system_stm32f0xx.c'];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readProject(id: string): Promise<Record<string, string>> {
  const dir = path.join(WORKSPACE, id);
  const files: Record<string, string> = {};
  if (!existsSync(dir)) return files;
  for (const name of await readdir(dir)) {
    if (SAFE_FILE.test(name)) files[name] = await readFile(path.join(dir, name), 'utf8');
  }
  return files;
}

/** Local API used by the playground: compile, debug info, and saving code to ./workspace. */
function mcuApi(): Plugin {
  return {
    name: 'mcu-playground-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!url.pathname.startsWith('/api/')) return next();
        try {
          const route = `${req.method} ${url.pathname}`;
          if (route === 'GET /api/status') {
            return send(res, 200, { toolchain: toolchainInstalled() });
          }
          if (route === 'POST /api/compile') {
            const body = JSON.parse(await readBody(req)) as { files: Array<{ name: string; content: string }>; opt?: OptLevel };
            const result = await compile(body.files, { opt: body.opt });
            return send(res, 200, {
              ok: result.ok,
              buildId: result.buildId,
              elf: result.elf ? Buffer.from(result.elf).toString('base64') : null,
              diagnostics: result.diagnostics,
              log: result.log,
              size: result.size ?? null,
            });
          }
          if (route === 'POST /api/addr2line') {
            const body = JSON.parse(await readBody(req)) as { buildId: string; addrs: number[] };
            return send(res, 200, await addr2line(body.buildId, body.addrs.slice(0, 32)));
          }
          if (route === 'GET /api/disasm') {
            return send(res, 200, { text: await disassemble(url.searchParams.get('build') ?? '') });
          }
          if (route === 'GET /api/firmware') {
            const files: Record<string, string> = {};
            for (const name of FIRMWARE_FILES) files[name] = await readFile(path.join(FIRMWARE_DIR, name), 'utf8');
            return send(res, 200, files);
          }
          if (route === 'GET /api/workspace') {
            const projects: Record<string, Record<string, string>> = {};
            if (existsSync(WORKSPACE)) {
              for (const id of await readdir(WORKSPACE)) {
                if (SAFE_PROJECT.test(id)) projects[id] = await readProject(id);
              }
            }
            return send(res, 200, projects);
          }
          const m = /^\/api\/workspace\/([^/]+)$/.exec(url.pathname);
          if (m && req.method === 'PUT') {
            const id = m[1];
            if (!SAFE_PROJECT.test(id)) return send(res, 400, { error: 'bad project id' });
            const body = JSON.parse(await readBody(req)) as { files: Record<string, string> };
            const dir = path.join(WORKSPACE, id);
            await mkdir(dir, { recursive: true });
            const keep = new Set<string>();
            for (const [name, content] of Object.entries(body.files)) {
              if (!SAFE_FILE.test(name)) continue;
              keep.add(name);
              await writeFile(path.join(dir, name), content);
            }
            for (const name of await readdir(dir)) {
              if (SAFE_FILE.test(name) && !keep.has(name)) await rm(path.join(dir, name));
            }
            return send(res, 200, { ok: true });
          }
          return send(res, 404, { error: 'not found' });
        } catch (e) {
          return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), mcuApi()],
  server: { port: 5183, strictPort: false, host: '127.0.0.1' },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 6000 },
});
