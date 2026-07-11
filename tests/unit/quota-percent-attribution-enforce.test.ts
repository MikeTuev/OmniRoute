/**
 * tests/unit/quota-percent-attribution-enforce.test.ts
 *
 * Bug: for percent dimensions the per-key consumption is always 0 (the
 * provider reports only the ACCOUNT-level utilization; nothing is written
 * locally for the percent unit). decideFairShare therefore compared 0 with
 * fairShare forever — hard/soft policies and weights were decorative for
 * percent-only plans (claude/codex): no key could ever be blocked for
 * exceeding its share.
 *
 * Fix: proportional attribution. The tokens/... telemetry buckets (written
 * per key by recordConsumption) give each key's share of the pool's proxy
 * traffic; the account-level percent is attributed to keys by that share:
 *
 *   consumedByKey(percent) = accountPercent × keyTokens / poolTokens
 *
 * With weights 50/50, account at 80% (strict mode) and one key having ~90%
 * of the pool's tokens, that key exceeds its fair share and hard-blocks,
 * while the other key still fits and passes.
 *
 * Real temp-dir SQLite store; the claude saturation source is injected via
 * __setAnthropicSaturationDepsForTests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pct-attr-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const poolsDb = await import("../../src/lib/db/quotaPools.ts");
const { getSqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.ts");
const { enforceQuotaShare } = await import("../../src/lib/quota/enforce.ts");
const satMod = await import("../../src/lib/quota/saturationSignals.ts");
const { _clearSaturationCache, _clearLastGoodSaturation, __setAnthropicSaturationDepsForTests } =
  satMod;

const CONN_ID = "conn-attr-1";
const KEY_HEAVY = "key-mike";
const KEY_LIGHT = "key-webui";

const OAUTH_CONN = { id: CONN_ID, provider: "claude", authType: "oauth", accessToken: "tok" };

function claudeUsage(fiveHourUtil: number) {
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
      "weekly (7d)": {
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

function setUtilization(pct: number) {
  _clearSaturationCache();
  _clearLastGoodSaturation();
  __setAnthropicSaturationDepsForTests({
    loadConnection: async () => OAUTH_CONN,
    fetchUsage: async () => claudeUsage(pct),
    loadCachedLimits: () => null,
  });
}

test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  _clearSaturationCache();
  _clearLastGoodSaturation();
  __setAnthropicSaturationDepsForTests(null);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// Shared pool: 2 keys, 50/50 hard. Telemetry: heavy key 90%, light key 10%.
const pool = poolsDb.createPool({
  connectionId: CONN_ID,
  name: "Attr Pool",
  allocations: [
    { apiKeyId: KEY_HEAVY, weight: 50, policy: "hard" },
    { apiKeyId: KEY_LIGHT, weight: 50, policy: "hard" },
  ],
});
const store = getSqliteQuotaStore();
await store.consume(KEY_HEAVY, { poolId: pool.id, unit: "tokens", window: "5h" }, 900_000);
await store.consume(KEY_LIGHT, { poolId: pool.id, unit: "tokens", window: "5h" }, 100_000);
await store.consume(KEY_HEAVY, { poolId: pool.id, unit: "tokens", window: "weekly" }, 900_000);
await store.consume(KEY_LIGHT, { poolId: pool.id, unit: "tokens", window: "weekly" }, 100_000);

test("strict mode: heavy key exceeds its attributed share → hard block", async () => {
  // Account at 80% (≥ 0.5 threshold → strict). Heavy key share 0.9:
  // consumed = 80 × 0.9 = 72 ≥ fairShare 50 → block (fair-share).
  setUtilization(80);
  const decision = await enforceQuotaShare({
    apiKeyId: KEY_HEAVY,
    connectionId: CONN_ID,
    provider: "claude",
    estimatedCost: {},
  });
  assert.equal(decision.kind, "block", `expected block, got ${JSON.stringify(decision)}`);
  assert.equal(decision.httpStatus, 429);
});

test("strict mode: light key within its attributed share → allow", async () => {
  // Light key share 0.1: consumed = 80 × 0.1 = 8 < fairShare 50 → allow.
  setUtilization(80);
  const decision = await enforceQuotaShare({
    apiKeyId: KEY_LIGHT,
    connectionId: CONN_ID,
    provider: "claude",
    estimatedCost: {},
  });
  assert.equal(decision.kind, "allow", `expected allow, got ${JSON.stringify(decision)}`);
});

test("generous mode: heavy key may borrow beyond its share → allow", async () => {
  // Account at 30% (< 0.5 → generous): hard policy borrows up to the pool
  // limit; consumed 30×0.9=27 < 100 → allow. Work-conserving semantics kept.
  setUtilization(30);
  const decision = await enforceQuotaShare({
    apiKeyId: KEY_HEAVY,
    connectionId: CONN_ID,
    provider: "claude",
    estimatedCost: {},
  });
  assert.equal(decision.kind, "allow", `expected allow, got ${JSON.stringify(decision)}`);
});
