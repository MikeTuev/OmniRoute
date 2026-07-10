/**
 * tests/unit/quota-pool-usage-percent-saturation.test.ts
 *
 * Bug: the GET /api/quota/pools/[id]/usage snapshot computed `consumedTotal`
 * purely from the SQLite consumption counters (peek per allocation). For
 * `percent` dimensions nothing is ever written locally (costForUnit returns 0),
 * so claude/codex pools — whose catalog plans are percent-only — permanently
 * displayed 0% while enforcement used the upstream saturation signal.
 *
 * Fix: overlay percent dimensions with the same saturation signal enforce.ts
 * uses: consumedTotal = Σ_connection (saturation × per-account limit), and the
 * effective limit scales with the number of pool connections (parity with
 * enforce.ts accountCount semantics).
 *
 * The helper is pure with an injectable getSaturation — no DB, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { applyPercentSaturation } = await import("../../src/lib/quota/poolUsageSaturation.ts");

function makeSnapshot() {
  return {
    poolId: "pool-1",
    generatedAt: "2026-07-10T00:00:00.000Z",
    dimensions: [
      {
        unit: "percent",
        window: "5h",
        limit: 100,
        consumedTotal: 0,
        perKey: [{ apiKeyId: "k1", consumed: 0, fairShare: 50, deficit: -50, borrowing: false }],
      },
      {
        unit: "percent",
        window: "weekly",
        limit: 100,
        consumedTotal: 0,
        perKey: [],
      },
      {
        unit: "requests",
        window: "hourly",
        limit: 1500,
        consumedTotal: 42,
        perKey: [],
      },
    ],
  };
}

test("percent dimensions get consumedTotal from the saturation signal", async () => {
  const snapshot = makeSnapshot();
  const calls: Array<{ connectionId: string; window: string }> = [];

  const result = await applyPercentSaturation(snapshot, {
    connectionIds: ["conn-a"],
    provider: "claude",
    getSaturation: async (connectionId, _provider, dim) => {
      calls.push({ connectionId, window: dim.window });
      return dim.window === "5h" ? 0.62 : 0.31;
    },
  });

  const fiveH = result.dimensions.find((d) => d.unit === "percent" && d.window === "5h");
  const weekly = result.dimensions.find((d) => d.unit === "percent" && d.window === "weekly");
  assert.ok(fiveH && weekly);
  // saturation × per-account limit: 0.62 × 100 = 62
  assert.ok(
    Math.abs(fiveH!.consumedTotal - 62) < 1e-9,
    `5h expected 62, got ${fiveH!.consumedTotal}`
  );
  assert.ok(
    Math.abs(weekly!.consumedTotal - 31) < 1e-9,
    `weekly expected 31, got ${weekly!.consumedTotal}`
  );
  assert.equal(calls.length, 2, "one saturation call per percent dimension per connection");
});

test("countable dimensions are left untouched", async () => {
  const snapshot = makeSnapshot();
  const result = await applyPercentSaturation(snapshot, {
    connectionIds: ["conn-a"],
    provider: "claude",
    getSaturation: async () => 0.9,
  });

  const req = result.dimensions.find((d) => d.unit === "requests");
  assert.equal(req!.consumedTotal, 42, "requests consumedTotal must not be overlaid");
  assert.equal(req!.limit, 1500, "requests limit must not be scaled");
});

test("multi-connection pool: limit scales ×N and consumption sums per connection", async () => {
  const snapshot = makeSnapshot();
  const result = await applyPercentSaturation(snapshot, {
    connectionIds: ["conn-a", "conn-b"],
    provider: "claude",
    getSaturation: async (connectionId, _provider, dim) => {
      if (dim.window !== "5h") return 0;
      return connectionId === "conn-a" ? 0.5 : 0.25;
    },
  });

  const fiveH = result.dimensions.find((d) => d.unit === "percent" && d.window === "5h");
  // limit: 100 × 2 accounts = 200; consumed: 0.5×100 + 0.25×100 = 75
  assert.equal(fiveH!.limit, 200, "percent limit scales with connection count");
  assert.ok(Math.abs(fiveH!.consumedTotal - 75) < 1e-9, `expected 75, got ${fiveH!.consumedTotal}`);
});

test("fail-open: saturation errors leave the dimension at its stored value", async () => {
  const snapshot = makeSnapshot();
  const result = await applyPercentSaturation(snapshot, {
    connectionIds: ["conn-a"],
    provider: "claude",
    getSaturation: async () => {
      throw new Error("upstream down");
    },
  });

  const fiveH = result.dimensions.find((d) => d.unit === "percent" && d.window === "5h");
  assert.equal(fiveH!.consumedTotal, 0, "errors must fail open to the stored value");
});

// ── Route wiring (structural, same pattern as quota-pool-usage-shape.test.ts) ──

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const routeSrc = readFileSync(join(ROOT, "src/app/api/quota/pools/[id]/usage/route.ts"), "utf8");

test("usage route overlays percent dimensions via applyPercentSaturation", () => {
  assert.ok(routeSrc.includes("applyPercentSaturation"), "route must call applyPercentSaturation");
  assert.ok(/getSaturation/.test(routeSrc), "route must wire the real getSaturation signal");
  assert.ok(
    /connectionIds/.test(routeSrc),
    "route must pass ALL pool member connections (not only the primary)"
  );
});
