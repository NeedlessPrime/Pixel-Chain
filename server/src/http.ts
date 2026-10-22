import { existsSync, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MAX_CANVAS_SIZE, MAX_REPORT_SIZE, isValidWallet, normalizeFaction } from '@pixel/shared';
import type { ArchiveFile } from './archive';
import { MAX_NONCE_LENGTH, adminTokenMatches, bearerToken } from './auth';
import { MAX_MOCK_BALANCE } from './balances';
import type { ServerConfig } from './config';
import { HTTP_MESSAGES } from './messages';
import type { PixelService, Refusal, RefusalCode } from './service';

/** A JSON error response: `{ error: code, message }` (message in French, shown to players). */
export class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

type Code = keyof typeof HTTP_MESSAGES;
const fail = (status: number, code: Code, message: string = HTTP_MESSAGES[code]) => new HttpError(status, code, message);
const badRequest = (message?: string) => fail(400, 'bad_request', message);

const REFUSAL_STATUS: Record<RefusalCode, number> = { not_holder: 403, rpc_unavailable: 503, too_many_reports: 429, faction_locked: 429 };
const refused = (r: Refusal) => new HttpError(REFUSAL_STATUS[r.code], r.code, r.message);

const REQUESTS_PER_MINUTE = 120;
const AUTH_REQUESTS_PER_MINUTE = 10;
const MAX_REASON_LENGTH = 300;

/* ---------------- input validation ---------------- */

type Body = Record<string, unknown>;

function objectBody(req: FastifyRequest): Body {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest();
  return body as Body;
}

function query(req: FastifyRequest): Record<string, unknown> {
  return (req.query ?? {}) as Record<string, unknown>;
}

/** An integer from a JSON number or a query string. */
function int(value: unknown, min: number, max: number): number {
  const n = typeof value === 'string' && /^-?\d{1,10}$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw badRequest();
  return n;
}

function walletParam(value: unknown): string {
  if (!isValidWallet(value)) throw fail(400, 'bad_wallet');
  return value;
}

function shortString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) throw badRequest();
  return value;
}

function reasonText(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_REASON_LENGTH) throw badRequest();
  return value.replace(/\p{Cc}/gu, ' ').trim();
}

/** `"size-mtime"`: changes whenever an archive is re-rendered (moderation during the break). */
function etagOf(stats: BigIntStats): string {
  return `"${stats.size.toString(36)}-${stats.mtimeNs.toString(36)}"`;
}

function etagMatches(header: string | undefined, etag: string): boolean {
  return !!header && header.split(',').some((t) => {
    const tag = t.trim().replace(/^W\//, '');
    return tag === etag || tag === '*';
  });
}

/* ---------------- app-wide handlers ---------------- */

export function installErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    const status = (err as { statusCode?: unknown }).statusCode;
    const clientError = typeof status === 'number' && status >= 400 && status < 500;
    if (!clientError) req.log.error(err);
    const code: Code = !clientError ? 'internal' : status === 429 ? 'rate_limited' : status === 404 ? 'not_found' : 'bad_request';
    return reply.code(clientError ? status : 500).send({ error: code, message: HTTP_MESSAGES[code] });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: HTTP_MESSAGES.not_found }));

  // Accept an empty body with a JSON content type (e.g. `fetch(url, { method: 'POST', headers })`).
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '') return done(null, {});
    parseJson(req, body as string, done);
  });
}

/* ---------------- routes ---------------- */

export interface HttpDeps {
  service: PixelService;
  config: ServerConfig;
}

/** Every /api route, behind the per-IP rate limits. Call inside an encapsulated plugin. */
export async function registerApi(app: FastifyInstance, deps: HttpDeps): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: REQUESTS_PER_MINUTE,
    timeWindow: 60_000,
    errorResponseBuilder: () => fail(429, 'rate_limited'),
  });
  publicRoutes(app, deps);
  authRoutes(app, deps);
  playerRoutes(app, deps);
  await app.register(async (admin) => adminRoutes(admin, deps));
}

function publicRoutes(app: FastifyInstance, { service }: HttpDeps): void {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/config', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return service.publicConfig();
  });

  app.get('/api/canvas', async (_req, reply) => {
    const canvas = service.canvas();
    return reply
      .header('content-type', 'application/octet-stream')
      .header('x-canvas-width', canvas.width)
      .header('x-canvas-height', canvas.height)
      .header('x-canvas-seq', canvas.seq)
      .header('cache-control', 'no-store')
      .send(canvas.bytes);
  });

  app.get('/api/pixel', async (req) => {
    const q = query(req);
    const info = service.pixelInfo(int(q.x, 0, MAX_CANVAS_SIZE), int(q.y, 0, MAX_CANVAS_SIZE));
    if (!info) throw badRequest('Ce pixel est hors de la toile');
    return info;
  });

  app.get('/api/leaderboard', async () => service.leaderboard());

  app.get('/api/seasons', async () => service.seasons());

  // Streamed (a timelapse can weigh tens of MB) and revalidated on every use, since moderation can re-render it.
  const archived = (file: ArchiveFile, type: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const filePath = service.archiveFile(id, file);
    if (!filePath) throw fail(404, 'not_found');
    // One handle for the stat and the stream, so both see the same file even if a re-render replaces it meanwhile.
    const handle = await open(filePath);
    const stats = await handle.stat({ bigint: true }).catch(async (err: unknown) => {
      await handle.close();
      throw err;
    });
    const etag = etagOf(stats);
    reply.header('content-type', type).header('cache-control', 'no-cache').header('etag', etag);
    if (etagMatches(req.headers['if-none-match'], etag)) {
      await handle.close();
      return reply.code(304).send();
    }
    return reply.header('content-length', stats.size.toString()).send(handle.createReadStream());
  };
  app.get('/api/seasons/:id/image.png', archived('image.png', 'image/png'));
  app.get('/api/seasons/:id/timelapse.bin', archived('timelapse.bin', 'application/octet-stream'));
}

function authRoutes(app: FastifyInstance, { service, config }: HttpDeps): void {
  // One counter shared by every /api/auth/* route (route-level limits would each get their own).
  const options = { config: { rateLimit: false as const }, onRequest: app.rateLimit({ max: AUTH_REQUESTS_PER_MINUTE, timeWindow: 60_000 }) };

  /** Domain written in the login message: PUBLIC_DOMAIN, else the request Host if it looks sane. */
  const domainOf = (req: FastifyRequest) => {
    if (config.publicDomain) return config.publicDomain;
    return /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(req.host) ? req.host : 'localhost';
  };

  app.post('/api/auth/nonce', options, async (req) => {
    return service.issueNonce(walletParam(objectBody(req).wallet), domainOf(req));
  });

  app.post('/api/auth/verify', options, async (req) => {
    const body = objectBody(req);
    const result = await service.login(walletParam(body.wallet), shortString(body.nonce, MAX_NONCE_LENGTH), shortString(body.signature, 128));
    if (!result.ok) throw fail(401, result.code);
    return result.res;
  });
}

function playerRoutes(app: FastifyInstance, { service }: HttpDeps): void {
  const walletOf = (req: FastifyRequest): string => {
    const session = service.session(bearerToken(req.headers.authorization));
    if (!session) throw fail(401, 'unauthenticated');
    return session.wallet;
  };

  app.get('/api/me', async (req) => {
    const refresh = query(req).refresh;
    return service.me(walletOf(req), refresh === '1' || refresh === 'true');
  });

  app.post('/api/me/faction', async (req) => {
    const wallet = walletOf(req);
    const raw = objectBody(req).faction;
    const faction = raw === null ? null : normalizeFaction(raw);
    if (raw !== null && !faction) throw fail(400, 'bad_faction');
    const result = await service.setFaction(wallet, faction);
    if (!result.ok) throw refused(result);
    return service.me(wallet);
  });

  app.post('/api/report', async (req) => {
    const wallet = walletOf(req);
    const body = objectBody(req);
    const { width, height } = service.game;
    const x = int(body.x, 0, width - 1);
    const y = int(body.y, 0, height - 1);
    const area = {
      x,
      y,
      w: Math.min(int(body.w, 1, MAX_REPORT_SIZE), width - x),
      h: Math.min(int(body.h, 1, MAX_REPORT_SIZE), height - y),
      reason: reasonText(body.reason),
    };
    const result = await service.report(wallet, area);
    if (!result.ok) throw refused(result);
    return { ok: true };
  });

  if (service.mockMode) {
    app.post('/api/dev/balance', async (req) => {
      const wallet = walletOf(req);
      const { balance } = objectBody(req);
      if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0 || balance > MAX_MOCK_BALANCE) {
        throw badRequest();
      }
      service.setMockBalance(wallet, balance);
      return service.me(wallet);
    });
  }
}

function adminRoutes(app: FastifyInstance, { service, config }: HttpDeps): void {
  app.addHook('onRequest', async (req) => {
    if (!config.adminToken) throw fail(404, 'admin_disabled');
    if (!adminTokenMatches(req.headers['x-admin-token'], config.adminToken)) throw fail(403, 'forbidden');
  });

  app.get('/api/admin/reports', async () => service.reports());

  app.post('/api/admin/reports/:id/resolve', async (req) => {
    const { id } = req.params as { id: string };
    if (!service.resolveReport(id)) throw fail(404, 'not_found');
    return { ok: true };
  });

  app.post('/api/admin/wipe', async (req) => {
    const body = objectBody(req);
    const x = int(body.x, 0, MAX_CANVAS_SIZE - 1);
    const y = int(body.y, 0, MAX_CANVAS_SIZE - 1);
    const erased = await service.wipe(x, y, int(body.w, 1, MAX_CANVAS_SIZE), int(body.h, 1, MAX_CANVAS_SIZE));
    return { ok: true, erased };
  });

  app.post('/api/admin/ban', async (req) => {
    const body = objectBody(req);
    if (body.wipe !== undefined && typeof body.wipe !== 'boolean') throw badRequest();
    const erased = await service.ban(walletParam(body.wallet), body.wipe === true);
    return { ok: true, erased };
  });

  app.post('/api/admin/unban', async (req) => {
    service.unban(walletParam(objectBody(req).wallet));
    return { ok: true };
  });

  app.post('/api/admin/season/end', async () => {
    if (!(await service.endSeason())) throw fail(409, 'season_frozen');
    return { ok: true };
  });

  app.post('/api/admin/season/start', async () => {
    if (!service.startSeason()) throw fail(409, 'season_live');
    return { ok: true };
  });

  app.post('/api/admin/resize', async (req) => {
    const body = objectBody(req);
    if (!service.resize(int(body.width, 1, MAX_CANVAS_SIZE), int(body.height, 1, MAX_CANVAS_SIZE))) {
      throw fail(400, 'bad_size');
    }
    return { ok: true };
  });
}

/** Serves the built web app when WEB_DIST exists. Returns whether it does. */
export async function registerStatic(app: FastifyInstance, webDist: string): Promise<boolean> {
  if (!existsSync(webDist)) return false;
  const hashedAssets = `${path.sep}assets${path.sep}`;
  await app.register(fastifyStatic, {
    root: webDist,
    setHeaders: (reply, filePath) => {
      reply.header('cache-control', filePath.includes(hashedAssets) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.get('/hall', (_req, reply) => reply.sendFile('hall.html'));
  app.get('/admin', (_req, reply) => reply.sendFile('admin.html'));
  return true;
}
