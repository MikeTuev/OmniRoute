/**
 * summarizeQuotas.ts — aggregate a connection's upstream quota windows into a
 * single {pct, resetAt} pair for the compact "Account quota" row.
 *
 * Invariant: resetAt always belongs to the SAME window whose percentage was
 * selected as the worst. Previously the worst % (typically the weekly window
 * for claude) was paired with the soonest reset across windows (always the 5h
 * window), showing a mismatched percent/countdown pair.
 */

import {
  parseQuotaData,
  calculatePercentage,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils";

export interface QuotaSummary {
  pct: number;
  resetAt: string | null;
}

/** Validate a resetAt candidate: must parse to a future timestamp. */
function validFutureIso(resetAt: unknown, nowMs: number): string | null {
  if (!resetAt) return null;
  const ts = new Date(resetAt as string).getTime();
  if (!Number.isFinite(ts) || ts <= nowMs) return null;
  return typeof resetAt === "string" ? resetAt : new Date(ts).toISOString();
}

/** Aggregate the worst-remaining quota window (pct + its OWN resetAt). */
export function summarizeQuotas(provider: string, raw: unknown): QuotaSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = parseQuotaData(provider, raw);
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  let worst: number | null = null;
  let worstResetAt: string | null = null;
  const now = Date.now();

  for (const q of parsed) {
    if (!q || q.unlimited) continue;
    const pct =
      q.remainingPercentage !== undefined
        ? Number(q.remainingPercentage)
        : calculatePercentage(q.used, q.total);
    if (!Number.isFinite(pct)) continue;
    if (worst === null || pct < worst) {
      worst = pct;
      worstResetAt = validFutureIso(q.resetAt, now);
    }
  }

  if (worst === null) return null;
  return { pct: Math.round(worst), resetAt: worstResetAt };
}
