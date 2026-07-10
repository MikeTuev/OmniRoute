/**
 * tests/unit/quota-percent-pool-telemetry.test.ts
 *
 * Bug: for percent-only plans (claude/codex catalog plans) recordConsumption
 * never wrote anything to quota_consumption — costForUnit returns 0 for the
 * `percent` unit, and the plan has no other dimensions. As a result the
 * quota-share dashboard's UsageLogCard showed "No usage yet" forever and
 * burn rate had no tokens data ("no data yet"), even under heavy traffic.
 *
 * Fix: recordConsumption additionally writes TELEMETRY buckets
 * (requests/5h and tokens/5h) for every pool-matched request, regardless of
 * the plan's dimensions. Telemetry is display-only:
 *   - the usage log (listConsumptionForPool) picks the rows up by poolId prefix;
 *   - burn rate can fall back to the tokens telemetry;
 *   - enforcement still reads ONLY the plan's dimensions, so telemetry
 *     never affects allow/block decisions.
 *
 * Uses a real temp-dir SQLite DB (same pattern as db-quota-consumption.test.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-quota-telemetry-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const poolsDb = await import("../../src/lib/db/quotaPools.ts");
const consumptionDb = await import("../../src/lib/db/quotaConsumption.ts");
const providerPlans = await import("../../src/lib/db/providerPlans.ts");
const { recordConsumption } = await import("../../src/lib/quota/enforce.ts");

const CONN_ID = "conn-claude-1";
const API_KEY_ID = "key-telemetry-1";

test.after(async () => {
  // Let fire-and-forget promises settle, then release the DB handle.
  await new Promise((resolve) => setTimeout(resolve, 100));
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("percent-only pool: recordConsumption writes requests+tokens telemetry buckets", async () => {
  const pool = poolsDb.createPool({
    connectionId: CONN_ID,
    name: "Claude Pool",
    allocations: [{ apiKeyId: API_KEY_ID, weight: 100, policy: "hard" }],
  });

  // No manual plan for this connection → catalog plan for provider "claude"
  // (percent-only: percent/5h + percent/weekly). Before the fix this recorded
  // nothing at all.
  await recordConsumption({
    apiKeyId: API_KEY_ID,
    connectionId: CONN_ID,
    provider: "claude",
    cost: { tokens: 1234, usd: 0.05, requests: 1 },
  });

  const events = consumptionDb.listConsumptionForPool(pool.id, 50);
  assert.ok(events.length > 0, "expected telemetry rows for a percent-only pool");

  const units = new Set(events.map((e) => e.unit));
  assert.ok(units.has("requests"), `expected a requests bucket, got units: ${[...units]}`);
  assert.ok(units.has("tokens"), `expected a tokens bucket, got units: ${[...units]}`);

  const tokensEvent = events.find((e) => e.unit === "tokens");
  assert.equal(tokensEvent!.consumed, 1234, "tokens telemetry must carry the request's tokens");
  const requestsEvent = events.find((e) => e.unit === "requests");
  assert.equal(requestsEvent!.consumed, 1, "requests telemetry must count the request");
});

test("plan with real countable dimensions: no duplicate telemetry rows for the same unit+window", async () => {
  const pool = poolsDb.createPool({
    connectionId: "conn-kimi-1",
    name: "Kimi Pool",
    allocations: [{ apiKeyId: API_KEY_ID, weight: 100, policy: "hard" }],
  });

  // Manual plan with a tokens/5h dimension — telemetry for tokens/5h must NOT
  // double-write on top of the plan dimension's own consume().
  providerPlans.upsertPlan(
    "conn-kimi-1",
    "kimi",
    [{ unit: "tokens", window: "5h", limit: 1_000_000 }],
    "manual"
  );

  await recordConsumption({
    apiKeyId: API_KEY_ID,
    connectionId: "conn-kimi-1",
    provider: "kimi",
    cost: { tokens: 500, usd: 0, requests: 1 },
  });

  const events = consumptionDb.listConsumptionForPool(pool.id, 50);
  const tokens5h = events.filter((e) => e.unit === "tokens" && e.window === "5h");
  assert.equal(tokens5h.length, 1, "tokens/5h must have exactly one row (no telemetry duplicate)");
  assert.equal(tokens5h[0].consumed, 500, "single write must carry the full token count");
});

test("telemetry never affects enforcement decisions (percent-only plan still allows)", async () => {
  const { enforceQuotaShare } = await import("../../src/lib/quota/enforce.ts");

  poolsDb.createPool({
    connectionId: "conn-claude-2",
    name: "Claude Pool 2",
    allocations: [{ apiKeyId: "key-enf", weight: 100, policy: "hard" }],
  });

  // Record heavy telemetry traffic…
  for (let i = 0; i < 5; i++) {
    await recordConsumption({
      apiKeyId: "key-enf",
      connectionId: "conn-claude-2",
      provider: "claude",
      cost: { tokens: 1_000_000, usd: 0, requests: 1 },
    });
  }

  // …enforcement still reads only the percent plan dimensions (saturation 0
  // in tests → generous mode) and must allow.
  const decision = await enforceQuotaShare({
    apiKeyId: "key-enf",
    connectionId: "conn-claude-2",
    provider: "claude",
    estimatedCost: {},
  });
  assert.equal(decision.kind, "allow", "telemetry buckets must not feed enforcement");
});
