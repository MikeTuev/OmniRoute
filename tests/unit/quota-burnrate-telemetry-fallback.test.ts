/**
 * tests/unit/quota-burnrate-telemetry-fallback.test.ts
 *
 * Bug: poolUsageWithDimensions computed burnRate ONLY from a plan dimension
 * with unit "tokens". percent-only plans (claude/codex) have no tokens
 * dimension, so the BurnRateChart showed "no data yet" forever.
 *
 * Fix: when the plan has no tokens dimension (or it has no consumption), fall
 * back to the display-only tokens telemetry bucket (poolId:tokens:5h) that
 * recordConsumption now writes for every pool-matched request.
 *
 * Uses a real temp-dir SQLite DB (same pattern as db-quota-consumption.test.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-burnrate-fb-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const poolsDb = await import("../../src/lib/db/quotaPools.ts");
const { getSqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.ts");

const API_KEY_ID = "key-burnrate-1";

test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const PERCENT_ONLY_DIMS = [
  { unit: "percent", window: "5h", limit: 100 },
  { unit: "percent", window: "weekly", limit: 100 },
];

test("percent-only plan: burnRate falls back to the tokens telemetry bucket", async () => {
  const pool = poolsDb.createPool({
    connectionId: "conn-br-1",
    name: "BurnRate Pool",
    allocations: [{ apiKeyId: API_KEY_ID, weight: 100, policy: "hard" }],
  });

  const store = getSqliteQuotaStore();
  // Simulate what recordConsumption's telemetry write does for a claude pool.
  await store.consume(API_KEY_ID, { poolId: pool.id, unit: "tokens", window: "5h" }, 50_000);

  const snapshot = await store.poolUsageWithDimensions(pool.id, PERCENT_ONLY_DIMS);

  assert.ok(snapshot.burnRate, "expected burnRate from the telemetry fallback");
  assert.ok(
    snapshot.burnRate!.tokensPerSecond > 0,
    `expected tokensPerSecond > 0, got ${snapshot.burnRate?.tokensPerSecond}`
  );
  // No token limit exists for a percent-only plan → no exhaustion projection.
  assert.equal(
    snapshot.burnRate!.timeToExhaustionMs,
    null,
    "telemetry fallback must not fabricate a time-to-exhaustion"
  );
});

test("percent-only plan without any telemetry: burnRate stays undefined", async () => {
  const pool = poolsDb.createPool({
    connectionId: "conn-br-2",
    name: "Empty Pool",
    allocations: [{ apiKeyId: API_KEY_ID, weight: 100, policy: "hard" }],
  });

  const store = getSqliteQuotaStore();
  const snapshot = await store.poolUsageWithDimensions(pool.id, PERCENT_ONLY_DIMS);

  assert.equal(snapshot.burnRate, undefined, "no data → no burnRate (renders 'no data yet')");
});

test("plan WITH a tokens dimension keeps the plan-based burnRate (with exhaustion)", async () => {
  const pool = poolsDb.createPool({
    connectionId: "conn-br-3",
    name: "Tokens Pool",
    allocations: [{ apiKeyId: API_KEY_ID, weight: 100, policy: "hard" }],
  });

  const store = getSqliteQuotaStore();
  await store.consume(API_KEY_ID, { poolId: pool.id, unit: "tokens", window: "5h" }, 10_000);

  const snapshot = await store.poolUsageWithDimensions(pool.id, [
    { unit: "tokens", window: "5h", limit: 1_000_000 },
  ]);

  assert.ok(snapshot.burnRate, "expected plan-based burnRate");
  assert.ok(snapshot.burnRate!.tokensPerSecond > 0);
  assert.ok(
    typeof snapshot.burnRate!.timeToExhaustionMs === "number" &&
      snapshot.burnRate!.timeToExhaustionMs > 0,
    "plan-based burnRate must project exhaustion against the plan limit"
  );
});

// ── windowTokens/windowLimit anchor for the chart (unit-mismatch fix) ────────

test("telemetry-fallback burnRate carries windowTokens and a null windowLimit", async () => {
  const pool = poolsDb.createPool({
    connectionId: "conn-br-4",
    name: "Anchor Pool",
    allocations: [{ apiKeyId: API_KEY_ID, weight: 100, policy: "hard" }],
  });

  const store = getSqliteQuotaStore();
  await store.consume(API_KEY_ID, { poolId: pool.id, unit: "tokens", window: "5h" }, 70_000);

  const snapshot = await store.poolUsageWithDimensions(pool.id, PERCENT_ONLY_DIMS);
  assert.ok(snapshot.burnRate, "expected burnRate");
  assert.ok(
    Math.abs((snapshot.burnRate!.windowTokens ?? 0) - 70_000) < 1,
    `windowTokens must carry the telemetry tokens, got ${snapshot.burnRate!.windowTokens}`
  );
  assert.equal(
    snapshot.burnRate!.windowLimit,
    null,
    "percent-only plan has no token limit → windowLimit null"
  );
});

test("plan-based burnRate carries windowTokens and the plan token limit", async () => {
  const pool = poolsDb.createPool({
    connectionId: "conn-br-5",
    name: "Anchor Tokens Pool",
    allocations: [{ apiKeyId: API_KEY_ID, weight: 100, policy: "hard" }],
  });

  const store = getSqliteQuotaStore();
  await store.consume(API_KEY_ID, { poolId: pool.id, unit: "tokens", window: "5h" }, 10_000);

  const snapshot = await store.poolUsageWithDimensions(pool.id, [
    { unit: "tokens", window: "5h", limit: 1_000_000 },
  ]);
  assert.ok(snapshot.burnRate);
  assert.ok(Math.abs((snapshot.burnRate!.windowTokens ?? 0) - 10_000) < 1);
  assert.equal(snapshot.burnRate!.windowLimit, 1_000_000);
});

// ── BurnRateChart must anchor on tokens, not dimensions[0] (structural) ─────

import { readFileSync } from "node:fs";
import { join } from "node:path";

test("BurnRateChart anchors the projection on burnRate tokens, not dimensions[0]", () => {
  const src = readFileSync(
    join(
      import.meta.dirname,
      "../..",
      "src/app/(dashboard)/dashboard/costs/quota-share/components/BurnRateChart.tsx"
    ),
    "utf8"
  );
  assert.ok(
    !src.includes("dimensions?.[0]") && !src.includes("dimensions[0]"),
    "must NOT anchor on the first dimension (percent limit 100 clamps a tokens/sec projection)"
  );
  assert.ok(src.includes("windowTokens"), "must anchor on burnRate.windowTokens");
  assert.ok(src.includes("windowLimit"), "must clamp only against the token limit when present");
});
