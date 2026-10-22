import type { Report } from '@pixel/shared';

export const MAX_OPEN_REPORTS_PER_WALLET = 10;
/** Resolved reports kept for the admin history; older ones are dropped. */
const MAX_RESOLVED_KEPT = 500;

export interface ReportsSnapshot {
  nextId: number;
  reports: Report[];
}

export type NewReport = Pick<Report, 'x' | 'y' | 'w' | 'h' | 'reason'>;

export class ReportStore {
  private reports: Report[] = [];
  private nextId = 1;

  /** Adds an open report, or returns null when the wallet already has too many open. */
  add(wallet: string, area: NewReport, now: number): Report | null {
    const open = this.reports.filter((r) => r.wallet === wallet && r.status === 'open').length;
    if (open >= MAX_OPEN_REPORTS_PER_WALLET) return null;
    const report: Report = { id: String(this.nextId++), ...area, wallet, createdAt: now, status: 'open' };
    this.reports.push(report);
    return report;
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
    this.reports = snap.reports.map((r) => ({ ...r }));
  }

  private dropOldResolved(): void {
    const resolved = this.reports.filter((r) => r.status === 'resolved');
    if (resolved.length <= MAX_RESOLVED_KEPT) return;
    const drop = new Set(resolved.slice(0, resolved.length - MAX_RESOLVED_KEPT));
    this.reports = this.reports.filter((r) => !drop.has(r));
  }
}
