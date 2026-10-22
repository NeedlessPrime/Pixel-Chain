import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import websocket from '@fastify/websocket';
import fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ArchiveStore } from './archive';
import { NonceStore } from './auth';
import { BalanceCache, MockBalances, RpcBalances, type BalanceProvider } from './balances';
import type { ServerConfig } from './config';
import { ServerEvents } from './events';
import { Game } from './game';
import { installErrorHandlers, registerApi, registerStatic } from './http';
import { loadLogo } from './logo';
import { Persistence, STATE_VERSION, loadOrCreateSecret, type LoadedState, type SaveSnapshot } from './persistence';
import { ReportStore } from './reports';
import { SeasonManager, newSeason } from './season';
import { PixelService } from './service';
import { Hub, MAX_FRAME_BYTES, registerWs } from './ws';

const TICK_MS = 1_000;
const SAVE_MS = 10_000;
const SWEEP_MS = 60_000;
const BODY_LIMIT_BYTES = 16 * 1024;

export interface AppOptions {
  config: ServerConfig;
  /** Injectable clock (ms epoch) so tests can fast-forward seasons. */
  now?: () => number;
  /** Overrides the provider chosen from MODE. */
  balanceProvider?: BalanceProvider;
  logger?: FastifyServerOptions['logger'];
  /** Run the season, save and broadcast timers (default true). Tests may drive `tick()` themselves. */
  timers?: boolean;
}

export interface PixelApp {
  http: FastifyInstance;
  service: PixelService;
  game: Game;
  season: SeasonManager;
  events: ServerEvents;
  hub: Hub;
  /** Whether WEB_DIST exists and is served. */
  servesWeb: boolean;
  listen(): Promise<string>;
  /** One step of the season lifecycle (normally run every second). */
  tick(): Promise<void>;
  /** Persists the state if anything changed (or always with force). */
  save(force?: boolean): Promise<void>;
  /** Stops timers and sockets, then saves. */
  close(): Promise<void>;
}

function createBalanceProvider(config: ServerConfig): BalanceProvider {
  return config.mode === 'mock' ? new MockBalances() : new RpcBalances(config.rpcUrl, config.token.mint!);
}

function restoreGame(loaded: LoadedState | null, config: ServerConfig, startedAt: number): Game {
  if (!loaded) return new Game(config.canvasWidth, config.canvasHeight, startedAt);
  const { state, colors, owners, times, log } = loaded;
  return Game.restore(state.game, colors, owners, times, log);
}

export async function createApp(opts: AppOptions): Promise<PixelApp> {
  const { config } = opts;
  const now = opts.now ?? Date.now;
  const bootTime = now();
  await mkdir(config.dataDir, { recursive: true });

  const http = fastify({
    logger: opts.logger ?? false,
    trustProxy: config.trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
    logController: new LogController({ disableRequestLogging: true }),
  });

  const sessionSecret = config.sessionSecret ?? (await loadOrCreateSecret(config.dataDir));
  const persistence = new Persistence(config.dataDir);
  const loaded = await persistence.load();
  const archives = new ArchiveStore(path.join(config.dataDir, 'archive'));
  await archives.load();

  const events = new ServerEvents();
  const provider = opts.balanceProvider ?? createBalanceProvider(config);
  const mock = provider instanceof MockBalances ? provider : null;
  mock?.load(loaded?.state.mockBalances);
  const balances = new BalanceCache(provider, { ttlMs: config.balanceTtlMs, now, onChange: (w) => events.emit('me', w) });

  const game = restoreGame(loaded, config, bootTime);
  game.dirty = !loaded;
  const reports = new ReportStore();
  if (loaded) reports.restore(loaded.state.reports);

  const logo = loadLogo(config.logoPath, (msg) => http.log.warn(msg));
  const season = new SeasonManager(loaded?.state.season ?? newSeason(1, bootTime, config), {
    config, now, game, archives, logo, events,
  });
  // A crash between the freeze and the archive write must not lose the season.
  if (!season.isLive() && !archives.has(season.id)) await season.archive();

  const nonces = new NonceStore(now);
  const service = new PixelService({
    config, now, game, season, balances, mock, reports, archives, nonces, events, sessionSecret,
  });
  const hub = new Hub(service, events, now, http.log);

  installErrorHandlers(http);
  await http.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
  await http.register(async (api) => {
    await registerApi(api, { service, config, now });
    registerWs(api, hub);
  });
  const servesWeb = await registerStatic(http, config.webDist);

  const snapshot = (): SaveSnapshot => ({
    state: {
      version: STATE_VERSION,
      season: season.state,
      game: game.snapshot(),
      reports: reports.snapshot(),
      mockBalances: mock?.toJSON(),
    },
    colors: game.colors.slice(),
    owners: game.owners.slice(),
    times: game.times.slice(),
    seasonId: season.id,
    log: game.log.bytes(),
  });

  const save = async (force = false): Promise<void> => {
    if (!game.dirty && !force) return;
    game.dirty = false;
    try {
      await persistence.save(snapshot());
    } catch (err) {
      game.dirty = true;
      http.log.error({ err }, 'saving the state failed');
    }
  };
  if (loaded?.legacy) await save(true);

  let ticking: Promise<void> | null = null;
  const tick = (): Promise<void> => {
    ticking ??= season
      .tick()
      .catch((err) => http.log.error({ err }, 'season tick failed'))
      .finally(() => (ticking = null));
    return ticking;
  };

  const timers: NodeJS.Timeout[] = [];
  if (opts.timers !== false) {
    hub.start();
    timers.push(
      setInterval(() => void tick(), TICK_MS),
      setInterval(() => void save(), SAVE_MS),
      setInterval(() => {
        nonces.sweep();
        balances.prune();
      }, SWEEP_MS),
    );
  }

  return {
    http, service, game, season, events, hub, servesWeb,
    listen: () => http.listen({ port: config.port, host: config.host }),
    tick,
    save,
    async close() {
      timers.forEach(clearInterval);
      hub.stop();
      await http.close();
      await ticking;
      await save(true);
    },
  };
}
