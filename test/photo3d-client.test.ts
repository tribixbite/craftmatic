/**
 * ComfyUI client and pipeline against a fake ComfyUI HTTP server (BIZ-39 / WP B15). No GPU. A live run is gated on
 * RUN_GPU_TESTS=1 and a ComfyUI at 127.0.0.1:8188.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ComfyClient, ComfyError, firstFile } from '../tools/photo3d/comfy';
import { photosToGlb } from '../tools/photo3d/pipeline';
import { readGlb } from '../tools/photo3d/glb';

/** Bytes standing in for a GLB at /view; the pipeline test swaps in a real tetrahedron. */
let glbBytes: Uint8Array = new TextEncoder().encode('glTF-not-really');
let maskPng: Buffer = Buffer.alloc(0);

interface Fake {
  server: http.Server;
  url: string;
  prompts: Record<string, unknown>[];
  uploads: string[];
  freed: number;
  /** History polls answered "not yet" before the entry appears. */
  pending: number;
  mode: 'ok' | 'error' | 'never' | 'reject' | 'hang-stats';
}

let fake: Fake;

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  const f: Fake = { server: http.createServer(), url: '', prompts: [], uploads: [], freed: 0, pending: 0, mode: 'ok' };
  f.server.on('request', async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const body = await readBody(req);
    const json = (code: number, obj: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === '/system_stats') {
      if (f.mode === 'hang-stats') return; // never answers
      return json(200, { system: {} });
    }
    if (u.pathname === '/upload/image') {
      const name = /filename="([^"]+)"/.exec(body.toString('latin1'))?.[1] ?? 'x.png';
      f.uploads.push(name);
      return json(200, { name, subfolder: '', type: 'input' });
    }
    if (u.pathname === '/prompt') {
      if (f.mode === 'reject') return json(400, { error: { message: 'Prompt outputs failed validation' } });
      f.prompts.push((JSON.parse(body.toString()) as { prompt: Record<string, unknown> }).prompt);
      return json(200, { prompt_id: `p${f.prompts.length}` });
    }
    if (u.pathname.startsWith('/history/')) {
      const id = u.pathname.split('/')[2]!;
      if (f.mode === 'never') return json(200, {});
      if (f.pending > 0) {
        f.pending--;
        return json(200, {});
      }
      if (f.mode === 'error') {
        return json(200, { [id]: { status: { status_str: 'error', messages: [['execution_error', { node_type: 'RemeshMesh', exception_message: 'boom' }]] } } });
      }
      const prompt = f.prompts[Number(id.slice(1)) - 1] as Record<string, { class_type: string }>;
      // A mask prompt saves one image per view; a generation prompt saves the GLB at node "save".
      const outputs: Record<string, unknown> = {};
      for (const k of Object.keys(prompt)) if (k.startsWith('save_')) outputs[k] = { images: [{ filename: `${k}.png`, subfolder: 'photo3d', type: 'output' }] };
      if (prompt['save']) outputs['save'] = { '3d': [{ filename: 'model.glb', subfolder: 'photo3d', type: 'output' }] };
      return json(200, { [id]: { status: { status_str: 'success', completed: true }, outputs } });
    }
    if (u.pathname === '/view') {
      const name = u.searchParams.get('filename') ?? '';
      res.writeHead(200);
      return void res.end(name.endsWith('.glb') ? Buffer.from(glbBytes) : maskPng);
    }
    if (u.pathname === '/free') {
      f.freed++;
      return json(200, {});
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r));
  f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}`;
  fake = f;
  // A mask the size of the photos used below: a white rectangle on black.
  const w = 200, h = 160;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 40; y < 140; y++) for (let x = 60; x < 140; x++) px.fill(255, (y * w + x) * 3, (y * w + x) * 3 + 3);
  maskPng = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
});

afterAll(() => new Promise<void>((r) => fake.server.close(() => r())));

const client = (over: Partial<ConstructorParameters<typeof ComfyClient>[0]> = {}) =>
  new ComfyClient({ url: fake.url, pollMs: 1, requestTimeoutMs: 300, ...over });

describe('photo3d ComfyUI client', () => {
  it('a mock ComfyUI returning a history entry yields the GLB bytes', async () => {
    fake.mode = 'ok';
    fake.pending = 2; // two polls before the entry shows up
    glbBytes = new TextEncoder().encode('glTF-bytes-123');
    const c = client();
    const ticks: number[] = [];
    const outs = await c.run({ save: { class_type: 'Save3DAdvanced', inputs: {} } }, (s) => ticks.push(s));
    expect(ticks.length).toBe(2);
    const bytes = await c.fetchFile(firstFile(outs, 'save'));
    expect(new TextDecoder().decode(bytes)).toBe('glTF-bytes-123');
  });

  it('uploads an image and returns the name LoadImage uses', async () => {
    const name = await client().upload('a.png', new Uint8Array([137, 80, 78, 71]));
    expect(name).toBe('a.png');
    expect(fake.uploads).toContain('a.png');
  });

  it('a failed job raises ComfyError with the execution error', async () => {
    fake.mode = 'error';
    await expect(client().run({})).rejects.toThrow(/boom/);
  });

  it('a rejected prompt raises ComfyError with the server message', async () => {
    fake.mode = 'reject';
    await expect(client().run({})).rejects.toThrow(/rejected the prompt.*validation/);
  });

  it('a job that never finishes times out', async () => {
    fake.mode = 'never';
    await expect(client({ jobTimeoutMs: 80 }).run({})).rejects.toThrow(/did not finish/);
  });

  it('alive() is false for a hung server within its timeout and for a closed port', async () => {
    fake.mode = 'hang-stats';
    const t0 = Date.now();
    expect(await client().alive(150)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
    fake.mode = 'ok';
    expect(await client().alive()).toBe(true);
    expect(await new ComfyClient({ url: 'http://127.0.0.1:1' }).alive(500)).toBe(false);
    await expect(new ComfyClient({ url: 'http://127.0.0.1:1', requestTimeoutMs: 500 }).queue({})).rejects.toBeInstanceOf(ComfyError);
  });

  it('firstFile finds a file under any output key and throws on none', () => {
    expect(firstFile({ n: { weird: [{ filename: 'a.glb' }] } }, 'n').filename).toBe('a.glb');
    expect(() => firstFile({ n: {} }, 'n')).toThrow(/no file/);
  });
});

describe('photo3d pipeline against the fake ComfyUI', () => {
  it('frames three views plus a mirrored right, runs the multi-view graph, frees memory and writes the GLB', async () => {
    fake.mode = 'ok';
    fake.pending = 0;
    fake.prompts.length = 0;
    fake.uploads.length = 0;
    fake.freed = 0;
    // A closed tetrahedron with linear colours, as GLB, so the pipeline reports a closed coloured mesh.
    const { buildTetraGlb } = await import('./photo3d-glb-fixture');
    glbBytes = buildTetraGlb();
    const dir = mkdtempSync(path.join(tmpdir(), 'photo3d-'));
    const photo = async (name: string): Promise<string> => {
      const p = path.join(dir, name);
      await sharp({ create: { width: 200, height: 160, channels: 3, background: { r: 30, g: 90, b: 200 } } }).jpeg().toFile(p);
      return p;
    };
    const out = path.join(dir, 'model.glb');
    const report = await photosToGlb(
      { front: await photo('f.jpg'), left: await photo('l.jpg'), back: await photo('b.jpg') },
      out,
      { comfy: { url: fake.url, pollMs: 1 } },
    );
    expect(report.views).toEqual(['front', 'left', 'back', 'right']);
    expect(report.mesh.closed).toBe(true);
    expect(report.mesh.hasVertexColour).toBe(true);
    expect(fake.freed).toBe(1);
    // Prompt 1 = masks, prompt 2 = generation with the four framed views and solid remeshing.
    expect(fake.prompts).toHaveLength(2);
    const gen = fake.prompts[1] as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(gen['remesh']!.inputs['sign_mode']).toBe('solid');
    expect(Object.keys(gen).filter((k) => k.startsWith('view_'))).toHaveLength(4);
    expect(existsSync(path.join(dir, 'model_work', 'view_right.png'))).toBe(true);
    expect(readGlb(readFileSync(out)).faces.length).toBe(12);
  });

  it('refuses a set without a front photo', async () => {
    await expect(photosToGlb({ left: 'x.jpg' }, 'x.glb', { comfy: { url: fake.url } })).rejects.toThrow(/front/);
  });
});

// Live run: RUN_GPU_TESTS=1 bun x vitest run test/photo3d-client.test.ts, with ComfyUI up on 127.0.0.1:8188.
// The recorded corpus run is in the B15 report; this only checks that the server answers.
describe.skipIf(!process.env['RUN_GPU_TESTS'])('photo3d live ComfyUI', () => {
  it('answers /system_stats', async () => {
    expect(await new ComfyClient().alive()).toBe(true);
  });
});
