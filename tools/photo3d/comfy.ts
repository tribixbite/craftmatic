/**
 * A minimal ComfyUI HTTP client with timeouts (BIZ-39 / WP B15). Ported from pokefit's `Comfy` class.
 *
 * Endpoints: `/system_stats`, `/upload/image`, `/prompt`, `/history/<id>`, `/view`, `/free`. Every request has
 * its own timeout (`requestTimeoutMs`), and `run` has an overall deadline (`jobTimeoutMs`), so a hung ComfyUI
 * can never block a caller forever.
 */

export class ComfyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ComfyError';
  }
}

export const DEFAULT_URL = 'http://127.0.0.1:8188';

export interface ComfyOptions {
  /** Base URL of the ComfyUI server. */
  url?: string;
  /** Overall deadline of one `run`, ms. Default one hour (a 4-view generation takes minutes). */
  jobTimeoutMs?: number;
  /** Deadline of each short HTTP request, ms. Default 60 s. */
  requestTimeoutMs?: number;
  /** Poll spacing of `run`, ms. Default 2 s. */
  pollMs?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** A file entry in a ComfyUI history output. */
export interface OutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

/** Node id to that node's output dict, as in a history entry's `outputs`. */
export type ComfyOutputs = Record<string, Record<string, unknown>>;

export class ComfyClient {
  readonly url: string;
  readonly clientId: string = crypto.randomUUID().replace(/-/g, '');
  private readonly jobTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pollMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ComfyOptions = {}) {
    this.url = (opts.url ?? DEFAULT_URL).replace(/\/+$/, '');
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 3_600_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One request with a deadline; network errors and timeouts become `ComfyError`. */
  private async request(path: string, init: RequestInit = {}, timeoutMs = this.requestTimeoutMs): Promise<Response> {
    try {
      return await this.fetchFn(this.url + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ComfyError(
        timedOut ? `ComfyUI ${path} did not answer within ${timeoutMs} ms` : `ComfyUI ${path} failed: ${String(err)}`,
        { cause: err },
      );
    }
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) throw new ComfyError(`ComfyUI ${path} returned HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return (await res.json()) as T;
  }

  /** Whether ComfyUI answers `/system_stats` within `timeoutMs`. */
  async alive(timeoutMs = 5_000): Promise<boolean> {
    try {
      const res = await this.request('/system_stats', {}, timeoutMs);
      await res.arrayBuffer();
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Unload models and free memory (POST /free). Pixal3D's multi-view conditioning keeps ~3 GiB of RAM per view
   * until this is called (ComfyUI issue #16620); one call after each job keeps every run like the first. Best effort.
   */
  async free(): Promise<void> {
    try {
      await this.request(
        '/free',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) },
        30_000,
      );
    } catch {
      /* best effort */
    }
  }

  /** Upload a PNG to ComfyUI's input folder; returns the name `LoadImage` uses. */
  async upload(name: string, png: Uint8Array): Promise<string> {
    const form = new FormData();
    form.set('overwrite', 'true');
    form.set('type', 'input');
    form.set('image', new Blob([png as BlobPart], { type: 'image/png' }), name);
    const res = await this.json<{ name: string; subfolder?: string }>('/upload/image', { method: 'POST', body: form });
    return res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
  }

  /** Queue a prompt; returns its id. A rejected prompt (HTTP 400 with node errors) throws with ComfyUI's message. */
  async queue(prompt: object): Promise<string> {
    const res = await this.request('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: this.clientId }),
    });
    if (!res.ok) throw new ComfyError(`ComfyUI rejected the prompt: ${(await res.text()).slice(0, 2000)}`);
    const body = (await res.json()) as { prompt_id?: string };
    if (!body.prompt_id) throw new ComfyError('ComfyUI accepted the prompt but returned no prompt_id');
    return body.prompt_id;
  }

  /**
   * Queue a prompt and wait for it; returns its outputs (node id to output dict). Throws `ComfyError` when the
   * job fails or `jobTimeoutMs` passes. `progress` receives the elapsed seconds on each poll.
   */
  async run(prompt: object, progress?: (elapsedSeconds: number) => void): Promise<ComfyOutputs> {
    const id = await this.queue(prompt);
    const t0 = Date.now();
    while (Date.now() - t0 < this.jobTimeoutMs) {
      const hist = await this.json<Record<string, { status?: { status_str?: string; completed?: boolean; messages?: [string, unknown][] }; outputs?: ComfyOutputs }>>(
        `/history/${encodeURIComponent(id)}`,
      );
      const entry = hist[id];
      if (entry) {
        const status = entry.status ?? {};
        if (status.status_str === 'error') {
          const msg = (status.messages ?? []).find((m) => m[0] === 'execution_error');
          throw new ComfyError(`ComfyUI failed: ${JSON.stringify(msg ? msg[1] : status).slice(0, 2000)}`);
        }
        if (status.completed ?? true) return entry.outputs ?? {};
      }
      progress?.((Date.now() - t0) / 1000);
      await this.sleep(this.pollMs);
    }
    throw new ComfyError(`ComfyUI did not finish within ${Math.round(this.jobTimeoutMs / 1000)} s`);
  }

  /** Download one output file (`/view`). */
  async fetchFile(item: OutputFile): Promise<Uint8Array> {
    const q = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder ?? '', type: item.type ?? 'output' });
    const res = await this.request(`/view?${q.toString()}`);
    if (!res.ok) throw new ComfyError(`ComfyUI /view returned HTTP ${res.status} for ${item.filename}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** The first `{filename, ...}` entry in node `node`'s output, whatever the output key is called. */
export function firstFile(outputs: ComfyOutputs, node: string): OutputFile {
  const out = outputs[node] ?? {};
  const isFile = (items: unknown): items is OutputFile[] =>
    Array.isArray(items) && items.length > 0 && typeof items[0] === 'object' && items[0] !== null && 'filename' in items[0];
  for (const key of ['3d', 'images', 'result', 'model_3d', 'files']) {
    const items = out[key];
    if (isFile(items)) return items[0]!;
  }
  for (const items of Object.values(out)) if (isFile(items)) return items[0]!;
  throw new ComfyError(`node ${node} produced no file: ${JSON.stringify(out).slice(0, 500)}`);
}
