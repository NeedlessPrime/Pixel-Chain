/**
 * French formatting helpers shared by every page.
 * UI strings follow French typography: a no-break space (U+00A0) before ! ? : ; and inside « ».
 */

const integer = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const relative = new Intl.RelativeTimeFormat('fr', { style: 'short', numeric: 'auto' });
const date = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTime = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** 12 345 */
export const fmtInt = (n: number) => integer.format(n);
/** 12 345,67 — balances may have decimals. */
export const fmtAmount = (n: number) => decimal.format(n);
/** 1 M, 100 k */
export const fmtCompact = (n: number) => compact.format(n);
export const fmtDate = (ms: number) => date.format(ms);
export const fmtDateTime = (ms: number) => dateTime.format(ms);
/** "1 pixel", "12 pixels" — French uses the singular for 0 and 1. */
export const fmtCount = (n: number, singular: string, plural = `${singular}s`) =>
  `${fmtInt(n)} ${Math.abs(n) < 2 ? singular : plural}`;

const pad = (n: number) => String(n).padStart(2, '0');

/** Countdown: "2 j 04:12:33", "04:12:33", "12:33". */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const clock = h > 0 || d > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d} j ${clock}` : clock;
}

/** Short cooldown: "0:42", "1:00". */
export function fmtCooldown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/** A delay between two pixels: "5 s", "2,5 s", "1 min". */
export function fmtDelay(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${decimal.format(ms / 1000)} s`;
}

/** "il y a 3 min", "à l'instant". */
export function fmtAgo(ms: number, now: number): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 10) return "à l'instant";
  if (s < 60) return relative.format(-s, 'second');
  if (s < 3600) return relative.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return relative.format(-Math.floor(s / 3600), 'hour');
  return relative.format(-Math.floor(s / 86400), 'day');
}

/** "×2" for a chaos factor of 0.5. */
export function fmtChaos(factor: number): string {
  return `×${decimal.format(1 / factor)}`;
}
