import type { Report } from '@pixel/shared';

export const MAX_OPEN_REPORTS_PER_WALLET = 10;
/** Open reports overall: past this, new ones wait until moderators catch up. */
export const MAX_OPEN_REPORTS = 2000;
/** Resolved reports kept for the admin history; older ones are dropped. */
const MAX_RESOLVED_KEPT = 500;

export interface ReportsSnapshot {
  nextId: number;
  reports: Report[];
}

export type NewReport = Pick<Report, 'x' | 'y' | 'w' | 'h' | 'reason'>;

export type AddReportResult = { ok: true; report: Report } | { ok: false; limit: 'wallet' | 'global' };

export class ReportStore {
  private reports: Report[] = [];
  private nextId = 1;

  /** Adds an open report, unless the wallet or everyone together already has too many open. */
  add(wallet: string, area: NewReport, seasonId: string, now: number): AddReportResult {
    let open = 0;
    let mine = 0;
    for (const r of this.reports) {
      if (r.status !== 'open') continue;
      open++;
      if (r.wallet === wallet) mine++;
    }
    if (mine >= MAX_OPEN_REPORTS_PER_WALLET) return { ok: false, limit: 'wallet' };
    if (open >= MAX_OPEN_REPORTS) return { ok: false, limit: 'global' };
    const report: Report = { id: String(this.nextId++), ...area, wallet, seasonId, createdAt: now, status: 'open' };
    this.reports.push(report);
    return { ok: true, report };
  }

  /** Open reports first, newest first within each group. */
  list(): Report[] {
    const rank = (r: Report) => (r.status === 'open' ? 0 : 1);
    return [...this.reports].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
  }

  resolve(id: string): boolean {
    const report = this.reports.find((r) => r.id === id);
    if (!report) return false;
    report.status = 'resolved';
    this.dropOldResolved();
    return true;
  }

  snapshot(): ReportsSnapshot {
    return { nextId: this.nextId, reports: this.reports.map((r) => ({ ...r })) };
  }

  restore(snap: ReportsSnapshot): void {
    this.nextId = snap.nextId;
    // Reports saved before seasonId existed belong to an unknown season.
    this.reports = snap.reports.map((r) => ({ ...r, seasonId: r.seasonId ?? '' }));
  }

  private dropOldResolved(): void {
    const resolved = this.reports.filter((r) => r.status === 'resolved');
    if (resolved.length <= MAX_RESOLVED_KEPT) return;
    const drop = new Set(resolved.slice(0, resolved.length - MAX_RESOLVED_KEPT));
    this.reports = this.reports.filter((r) => !drop.has(r));
  }
}
