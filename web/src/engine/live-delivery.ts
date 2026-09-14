export interface LiveSessionInfo {
  sessionId: string;
  minecraftUrl: string;
  browserUrl: string;
  browserToken: string;
  pairingCommand: string;
  expiresAt: string;
}

export type LiveDeliveryPhase =
  | 'connecting'
  | 'pairing'
  | 'probing'
  | 'transferring'
  | 'committing'
  | 'complete';

export interface LiveDeliveryProgress {
  phase: LiveDeliveryPhase;
  acknowledged: number;
  total: number;
  message?: string;
}

export interface LiveDeliveryResult {
  checksum: string;
  chunks: number;
  bytes: number;
  player: string;
}

export interface LiveDeliveryOptions {
  signal?: AbortSignal;
  onProgress?: (progress: LiveDeliveryProgress) => void;
}

interface ServerMessage {
  type: 'authenticated' | 'paired' | 'unpaired' | 'progress' | 'complete' | 'cancelled' | 'error';
  phase?: LiveDeliveryPhase;
  acknowledged?: number;
  total?: number;
  message?: string;
  code?: string;
  checksum?: string;
  chunks?: number;
  bytes?: number;
  player?: string;
}

export class LiveDeliveryError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'LiveDeliveryError';
  }
}

const DEFAULT_BASE_URL = 'https://craftmatic.click';
const MAX_HS1_BYTES = 4 * 1024 * 1024;

export async function createLiveSession(
  baseUrl = DEFAULT_BASE_URL,
  signal?: AbortSignal,
): Promise<LiveSessionInfo> {
  const response = await fetch(new URL('/connect', baseUrl), { method: 'POST', signal });
  if (!response.ok) throw new Error(`Could not create live-delivery session (HTTP ${response.status})`);
  const value = await response.json() as Partial<LiveSessionInfo>;
  if (!value.sessionId || !value.minecraftUrl || !value.browserUrl || !value.browserToken ||
      !value.pairingCommand || !value.expiresAt) throw new Error('Live-delivery service returned an invalid session');
  return value as LiveSessionInfo;
}

export class LiveDelivery {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private deliveryResolve: ((result: LiveDeliveryResult) => void) | null = null;
  private deliveryReject: ((error: Error) => void) | null = null;
  private onProgress: ((progress: LiveDeliveryProgress) => void) | null = null;

  constructor(readonly session: LiveSessionInfo) {}

  connect(signal?: AbortSignal): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      const socket = new WebSocket(this.session.browserUrl);
      this.socket = socket;
      const abort = () => {
        socket.close(1000, 'Cancelled');
        reject(new DOMException('Live delivery was cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'auth', token: this.session.browserToken }));
      });
      socket.addEventListener('message', event => this.handleMessage(event.data));
      socket.addEventListener('error', () => this.fail(new Error('Live-delivery WebSocket failed')));
      socket.addEventListener('close', event => {
        signal?.removeEventListener('abort', abort);
        if (event.code !== 1000) this.fail(new Error(event.reason || 'Live-delivery WebSocket closed'));
        this.socket = null;
        this.connectPromise = null;
      });
    });
    return this.connectPromise;
  }

  async deliver(
    encoded: string,
    checksum: string,
    options: LiveDeliveryOptions = {},
  ): Promise<LiveDeliveryResult> {
    validateHs1Input(encoded, checksum);
    if (options.signal?.aborted) throw new DOMException('Live delivery was cancelled', 'AbortError');
    options.onProgress?.({ phase: 'connecting', acknowledged: 0, total: 0 });
    await this.connect(options.signal);
    if (this.deliveryResolve) throw new Error('A live delivery is already running');
    return new Promise<LiveDeliveryResult>((resolve, reject) => {
      this.deliveryResolve = resolve;
      this.deliveryReject = reject;
      this.onProgress = options.onProgress ?? null;
      const abort = () => {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel' }));
        this.finishDelivery(new DOMException('Live delivery was cancelled', 'AbortError'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      const resolveWrapped = this.deliveryResolve;
      const rejectWrapped = this.deliveryReject;
      this.deliveryResolve = result => {
        options.signal?.removeEventListener('abort', abort);
        resolveWrapped(result);
      };
      this.deliveryReject = error => {
        options.signal?.removeEventListener('abort', abort);
        rejectWrapped(error);
      };
      this.socket!.send(JSON.stringify({ type: 'import', encoded, checksum }));
    });
  }

  close(): void {
    this.finishDelivery(new Error('Live delivery closed'));
    this.socket?.close(1000, 'Closed');
    this.socket = null;
    this.connectPromise = null;
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: ServerMessage;
    try { message = JSON.parse(data) as ServerMessage; } catch { return; }
    if (message.type === 'authenticated') {
      this.connectResolve?.();
      this.connectResolve = null;
      this.connectReject = null;
      return;
    }
    if (message.type === 'progress' && message.phase &&
        typeof message.acknowledged === 'number' && typeof message.total === 'number') {
      this.onProgress?.({
        phase: message.phase,
        acknowledged: message.acknowledged,
        total: message.total,
        message: message.message,
      });
      return;
    }
    if (message.type === 'complete' && message.checksum && message.player &&
        typeof message.chunks === 'number' && typeof message.bytes === 'number') {
      this.onProgress?.({ phase: 'complete', acknowledged: message.chunks, total: message.chunks });
      const resolve = this.deliveryResolve;
      this.clearDelivery();
      resolve?.({ checksum: message.checksum, chunks: message.chunks, bytes: message.bytes, player: message.player });
      return;
    }
    if (message.type === 'unpaired' && this.deliveryReject) {
      this.fail(new LiveDeliveryError(
        'Minecraft disconnected during delivery. Reopen the host world and retry with a new pairing command.',
        'minecraft_disconnected',
      ));
      return;
    }
    if (message.type === 'error') {
      this.fail(new LiveDeliveryError(message.message || message.code || 'Live delivery failed', message.code));
    }
  }

  private fail(error: Error): void {
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
    this.connectPromise = null;
    this.finishDelivery(error);
  }

  private finishDelivery(error: Error): void {
    const reject = this.deliveryReject;
    this.clearDelivery();
    reject?.(error);
  }

  private clearDelivery(): void {
    this.deliveryResolve = null;
    this.deliveryReject = null;
    this.onProgress = null;
  }
}

function validateHs1Input(encoded: string, checksum: string): void {
  if (!encoded || encoded.length > MAX_HS1_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Invalid or oversized HS1 payload');
  }
  if (!/^[0-9a-f]{8}$/.test(checksum)) throw new Error('Invalid HS1 checksum');
  let hash = 0x811c9dc5;
  for (let i = 0; i < encoded.length; i++) {
    hash ^= encoded.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  if ((hash >>> 0).toString(16).padStart(8, '0') !== checksum) throw new Error('HS1 checksum does not match payload');
}
