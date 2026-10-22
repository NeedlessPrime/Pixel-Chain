/**
 * Server-corrected clock: cooldowns and season deadlines are server epochs,
 * so countdowns must not depend on how wrong the device clock is.
 */
let offsetMs = 0;

/** Call with `PublicConfig.serverTime`, measured right after the response arrived. */
export function syncClock(serverTime: number): void {
  offsetMs = serverTime - Date.now();
}

export function serverNow(): number {
  return Date.now() + offsetMs;
}

type Tick = (now: number) => void;
const ticks = new Set<Tick>();
let timer: ReturnType<typeof setInterval> | null = null;

/** One shared timer for every countdown on the page (4 Hz so seconds never visibly lag). */
export function onTick(fn: Tick): () => void {
  ticks.add(fn);
  if (!timer) {
    timer = setInterval(() => {
      const now = serverNow();
      for (const t of ticks) t(now);
    }, 250);
  }
  fn(serverNow());
  return () => {
    ticks.delete(fn);
    if (ticks.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
