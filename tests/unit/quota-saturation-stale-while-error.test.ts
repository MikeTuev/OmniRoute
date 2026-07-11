/**
 * tests/unit/quota-saturation-stale-while-error.test.ts
 *
 * Bug: the claude OAuth usage endpoint is independently rate-limited; on a
 * 429 a 3-minute cooldown makes getClaudeUsage return a legacy shape with no
 * 5h/weekly windows. planUtilizationFromUsage then yields null, the header
 * fallback is usually empty, and getSaturation CACHED 0 for 30s. The
 * dashboard percent bars (and enforcement) flapped: real % for a while, then
 * 0% for every cooldown window.
 *
 * Fix: stale-while-error. getSaturation remembers the last GOOD value per
 * cache key; when a fresh fetch yields no signal (fetch failed / cooldown /
 * no header data), it serves the last good value instead of 0. A real,
 * successfully-fetched 0 still overwrites the last-good value.
 */

import test from "node:test";
import assert from "node:assert/strict";

const satMod = await import("../../src/lib/quota/saturationSignals.ts");
const {
  getSaturation,
  _clearSaturationCache,
  _clearRateLimitHeaders,
  __setAnthropicSaturationDepsForTests,
} = satMod;

const OAUTH_CONN = {
  id: "claude-stale-1",
  provider: "claude",
  authType: "oauth",
  accessToken: "fake-oauth-token",
};

function usageWithWindows(fiveHourUtil: number) {
  return {
    quotas: {
      "session (5h)": {
        used: fiveHourUtil,
        total: 100,
        remaining: 100 - fiveHourUtil,
        remainingPercentage: 100 - fiveHourUtil,
        resetAt: null,
        unlimited: false,
      },
    },
    bootstrap: null,
  };
}

/** Shape getClaudeUsage returns while the OAuth 429 cooldown is active. */
const COOLDOWN_LEGACY_USAGE = { message: "cooling down", bootstrap: null };

test.afterEach(() => {
  _clearSaturationCache();
  _clearRateLimitHeaders();
  __setAnthropicSaturationDepsForTests(null);
});

const DIM_5H = { unit: "percent", window: "5h" } as const;

test("cooldown after a good fetch serves the last good value, not 0", async () => {
  _clearSaturationCache();

  // 1st call: healthy usage → 0.62
  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    fetchUsage: async () => usageWithWindows(62),
  });
  const first = await getSaturation("claude-stale-1", "claude", DIM_5H);
  assert.ok(Math.abs(first - 0.62) < 1e-9, `expected 0.62, got ${first}`);

  // 2nd call (cache expired): endpoint cooling down → legacy shape, no windows.
  _clearSaturationCache();
  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    fetchUsage: async () => COOLDOWN_LEGACY_USAGE,
  });
  const second = await getSaturation("claude-stale-1", "claude", DIM_5H);
  assert.ok(
    Math.abs(second - 0.62) < 1e-9,
    `cooldown must serve the last good value 0.62, got ${second}`
  );
});

test("fetch that throws serves the last good value, not 0", async () => {
  _clearSaturationCache();

  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    fetchUsage: async () => usageWithWindows(31),
  });
  const first = await getSaturation("claude-stale-2", "claude", DIM_5H);
  assert.ok(Math.abs(first - 0.31) < 1e-9);

  _clearSaturationCache();
  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => {
      throw new Error("db down");
    },
    fetchUsage: async () => {
      throw new Error("unreachable");
    },
  });
  const second = await getSaturation("claude-stale-2", "claude", DIM_5H);
  assert.ok(
    Math.abs(second - 0.31) < 1e-9,
    `error must serve the last good value 0.31, got ${second}`
  );
});

test("a REAL fetched 0 overwrites the last good value", async () => {
  _clearSaturationCache();

  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    fetchUsage: async () => usageWithWindows(80),
  });
  const first = await getSaturation("claude-stale-3", "claude", DIM_5H);
  assert.ok(Math.abs(first - 0.8) < 1e-9);

  // Window reset upstream: utilization genuinely 0 now.
  _clearSaturationCache();
  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    fetchUsage: async () => usageWithWindows(0),
  });
  const second = await getSaturation("claude-stale-3", "claude", DIM_5H);
  assert.equal(second, 0, "a real 0 utilization must be served as 0");

  // And a subsequent failure serves the real 0 (the new last-good), fine.
  _clearSaturationCache();
  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    fetchUsage: async () => COOLDOWN_LEGACY_USAGE,
  });
  const third = await getSaturation("claude-stale-3", "claude", DIM_5H);
  assert.equal(third, 0);
});

test("no prior good value: failure still fails open to 0", async () => {
  _clearSaturationCache();
  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    fetchUsage: async () => COOLDOWN_LEGACY_USAGE,
  });
  const v = await getSaturation("claude-stale-fresh", "claude", DIM_5H);
  assert.equal(v, 0, "fail-open baseline unchanged when nothing good was ever seen");
});
