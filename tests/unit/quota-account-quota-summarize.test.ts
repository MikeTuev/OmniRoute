/**
 * tests/unit/quota-account-quota-summarize.test.ts
 *
 * Bug: the "Account quota" row on the quota-share dashboard paired the WORST
 * remaining percentage across windows (for claude under weekly load — the
 * weekly window) with the SOONEST resetAt across windows (always the 5h
 * window). The user saw "weekly %" next to a "5h countdown".
 *
 * Fix: summarizeQuotas must take resetAt from the SAME quota entry whose
 * percentage was selected as worst.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { summarizeQuotas } =
  await import("../../src/app/(dashboard)/dashboard/costs/quota-share/components/summarizeQuotas.ts");

function claudeRaw(opts: {
  fiveHourPct: number;
  fiveHourReset: string;
  weeklyPct: number;
  weeklyReset: string;
}) {
  // Shape produced by getClaudeUsage(): quotas keyed by window name, each with
  // used/total/remainingPercentage/resetAt (percent-only entries).
  return {
    quotas: {
      "session (5h)": {
        used: 100 - opts.fiveHourPct,
        total: 100,
        remainingPercentage: opts.fiveHourPct,
        resetAt: opts.fiveHourReset,
      },
      "weekly (7d)": {
        used: 100 - opts.weeklyPct,
        total: 100,
        remainingPercentage: opts.weeklyPct,
        resetAt: opts.weeklyReset,
      },
    },
  };
}

test("resetAt comes from the same window as the worst percentage (weekly worst)", () => {
  const in1h = new Date(Date.now() + 3_600_000).toISOString();
  const in3d = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();

  // weekly is the worst (12% remaining); 5h window resets sooner (in 1h).
  const summary = summarizeQuotas(
    "claude",
    claudeRaw({ fiveHourPct: 80, fiveHourReset: in1h, weeklyPct: 12, weeklyReset: in3d })
  );

  assert.ok(summary, "expected a summary");
  assert.equal(summary!.pct, 12, "worst pct must be the weekly one");
  assert.equal(
    summary!.resetAt,
    in3d,
    "resetAt must belong to the weekly window (the worst one), not the sooner 5h reset"
  );
});

test("resetAt follows the 5h window when it is the worst", () => {
  const in1h = new Date(Date.now() + 3_600_000).toISOString();
  const in3d = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();

  const summary = summarizeQuotas(
    "claude",
    claudeRaw({ fiveHourPct: 5, fiveHourReset: in1h, weeklyPct: 60, weeklyReset: in3d })
  );

  assert.ok(summary);
  assert.equal(summary!.pct, 5);
  assert.equal(summary!.resetAt, in1h, "resetAt must belong to the 5h window");
});

test("worst window without a resetAt yields resetAt = null (no borrowing)", () => {
  const in3d = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();

  // Worst window (5h) has NO reset info — must NOT borrow the other window's reset.
  // (A PAST resetAt is a different case: parseQuotaData stale-adjusts such
  // windows back to 100% remaining upstream, so it can never be the worst.)
  const summary = summarizeQuotas(
    "claude",
    claudeRaw({ fiveHourPct: 5, fiveHourReset: "", weeklyPct: 60, weeklyReset: in3d })
  );

  assert.ok(summary);
  assert.equal(summary!.pct, 5);
  assert.equal(
    summary!.resetAt,
    null,
    "missing reset on the worst window → null, not another window's"
  );
});

test("returns null for empty/invalid raw data", () => {
  assert.equal(summarizeQuotas("claude", null), null);
  assert.equal(summarizeQuotas("claude", {}), null);
});
