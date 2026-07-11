/**
 * tests/unit/quota-saturation-provider-limits-cache.test.ts
 *
 * Bug: the claude/anthropic saturation signal polled the OAuth usage endpoint
 * directly. That endpoint is independently rate-limited (429 → 3-min cooldown)
 * and the dashboard's provider-limits sync polls it too, so getSaturation
 * frequently got "no signal" and the percent bars sat at 0% — while the VERY
 * SAME utilization (e.g. 92%) was visible in the Account-quota row, served
 * from the persistent provider-limits DB cache (key_value namespace
 * providerLimitsCache, quotas["session (5h)"].used / ["weekly (7d)"].used).
 *
 * Fix: fetchAnthropicSaturation falls back to that DB cache before giving up.
 * Priority: live oauth/usage → provider-limits cache → rate-limit headers.
 */

import test from "node:test";
import assert from "node:assert/strict";

const satMod = await import("../../src/lib/quota/saturationSignals.ts");
const {
  getSaturation,
  _clearSaturationCache,
  _clearLastGoodSaturation,
  _clearRateLimitHeaders,
  __setAnthropicSaturationDepsForTests,
} = satMod;

const OAUTH_CONN = {
  id: "claude-plc-1",
  provider: "claude",
  authType: "oauth",
  accessToken: "fake-oauth-token",
};

/** provider-limits cache entry shape (src/lib/db/providerLimits.ts). */
function cacheEntry(fiveHourUsed: number, weeklyUsed: number) {
  return {
    quotas: {
      "session (5h)": { used: fiveHourUsed, total: 100, remainingPercentage: 100 - fiveHourUsed },
      "weekly (7d)": { used: weeklyUsed, total: 100, remainingPercentage: 100 - weeklyUsed },
    },
    plan: "Claude Max",
    message: null,
    fetchedAt: new Date().toISOString(),
  };
}

test.afterEach(() => {
  _clearSaturationCache();
  _clearLastGoodSaturation();
  _clearRateLimitHeaders();
  __setAnthropicSaturationDepsForTests(null);
});

test("oauth cooldown + provider-limits cache present → cache utilization served", async () => {
  _clearSaturationCache();
  _clearLastGoodSaturation();

  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    // Cooldown shape: no per-window quotas at all.
    fetchUsage: async () => ({ message: "cooling down", bootstrap: null }),
    loadCachedLimits: () => cacheEntry(92, 31),
  });

  const fiveH = await getSaturation("claude-plc-1", "claude", { unit: "percent", window: "5h" });
  assert.ok(Math.abs(fiveH - 0.92) < 1e-9, `expected 0.92 from the DB cache, got ${fiveH}`);

  _clearSaturationCache();
  const weekly = await getSaturation("claude-plc-1", "claude", {
    unit: "percent",
    window: "weekly",
  });
  assert.ok(Math.abs(weekly - 0.31) < 1e-9, `expected 0.31 from the DB cache, got ${weekly}`);
});

test("live oauth usage wins over the provider-limits cache", async () => {
  _clearSaturationCache();
  _clearLastGoodSaturation();

  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    fetchUsage: async () => ({
      quotas: {
        "session (5h)": { used: 55, total: 100, remainingPercentage: 45 },
      },
      bootstrap: null,
    }),
    loadCachedLimits: () => cacheEntry(92, 31),
  });

  const v = await getSaturation("claude-plc-1", "claude", { unit: "percent", window: "5h" });
  assert.ok(Math.abs(v - 0.55) < 1e-9, `live 0.55 must beat cached 0.92, got ${v}`);
});

test("no oauth, no cache → still fails open to 0", async () => {
  _clearSaturationCache();
  _clearLastGoodSaturation();

  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    fetchUsage: async () => ({ message: "cooling down", bootstrap: null }),
    loadCachedLimits: () => null,
  });

  const v = await getSaturation("claude-plc-nocache", "claude", {
    unit: "percent",
    window: "5h",
  });
  assert.equal(v, 0);
});
