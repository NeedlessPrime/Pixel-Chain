import { createApp } from './app';
import { ConfigError, loadConfig, type ServerConfig } from './config';

function readConfig(): ServerConfig {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Invalid configuration: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const app = await createApp({ config, logger: { level: 'info' } });
  const address = await app.listen();
  const log = app.http.log;
  log.info(
    `$PIXEL server listening on ${address} — mode=${config.mode}, port=${config.port}, data=${config.dataDir}, ` +
      `admin=${config.adminToken ? 'enabled' : 'disabled'}, web=${app.servesWeb ? config.webDist : 'not built'}, ` +
      `season=${app.season.id} (${app.season.state.status})`,
  );
  if (config.mode === 'live' && !config.sessionSecret) log.warn('SESSION_SECRET is not set: using the one stored in DATA_DIR/secret');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received: saving state and shutting down`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
