import type {
  ApiError,
  Leaderboard,
  MeInfo,
  NonceResponse,
  PixelInfo,
  PublicConfig,
  ReportRequest,
  SeasonArchive,
  VerifyResponse,
} from '@pixel/shared';

/** A non-2xx response, carrying the server's `ApiError` when it sent one. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

let authToken: string | null = null;

/** Session token sent as `Authorization: Bearer` on authenticated calls. */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  auth?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth) {
    if (!authToken) throw new ApiRequestError(401, 'unauthenticated', 'Connecte ton wallet pour continuer.');
    headers.authorization = `Bearer ${authToken}`;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError(0, 'network', 'Serveur injoignable. Vérifie ta connexion.');
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

async function toApiError(res: Response): Promise<ApiRequestError> {
  let body: Partial<ApiError> = {};
  try {
    body = (await res.json()) as Partial<ApiError>;
  } catch {
    // Not JSON (proxy error page…): fall back to the status text below.
  }
  // An empty message lets the UI fall back to its own French text for that status.
  return new ApiRequestError(res.status, body.error ?? `http_${res.status}`, body.message ?? '');
}

export interface CanvasSnapshot {
  width: number;
  height: number;
  /** Seq of the last change included in `colors`. */
  seq: number;
  colors: Uint8Array;
}

export async function fetchCanvas(signal?: AbortSignal): Promise<CanvasSnapshot> {
  const res = await fetch('/api/canvas', { cache: 'no-store', signal });
  if (!res.ok) throw await toApiError(res);
  const width = Number(res.headers.get('X-Canvas-Width'));
  const height = Number(res.headers.get('X-Canvas-Height'));
  const seq = Number(res.headers.get('X-Canvas-Seq'));
  const colors = new Uint8Array(await res.arrayBuffer());
  if (!(width > 0 && height > 0) || colors.length !== width * height || !Number.isFinite(seq)) {
    throw new ApiRequestError(res.status, 'bad_canvas', 'Toile reçue invalide.');
  }
  return { width, height, seq, colors };
}

export const api = {
  config: () => request<PublicConfig>('/api/config'),
  pixel: (x: number, y: number, signal?: AbortSignal) => request<PixelInfo>(`/api/pixel?x=${x}&y=${y}`, { signal }),
  leaderboard: () => request<Leaderboard>('/api/leaderboard'),
  seasons: () => request<SeasonArchive[]>('/api/seasons'),
  nonce: (wallet: string) => request<NonceResponse>('/api/auth/nonce', { body: { wallet } }),
  verify: (wallet: string, nonce: string, signature: string) =>
    request<VerifyResponse>('/api/auth/verify', { body: { wallet, nonce, signature } }),
  me: (refresh = false) => request<MeInfo>(refresh ? '/api/me?refresh=1' : '/api/me', { auth: true }),
  setFaction: (faction: string | null) => request<MeInfo>('/api/me/faction', { body: { faction }, auth: true }),
  report: (r: ReportRequest) => request<{ ok: true }>('/api/report', { body: r, auth: true }),
  devBalance: (balance: number) => request<MeInfo>('/api/dev/balance', { body: { balance }, auth: true }),
};
