/**
 * poolUsageSaturation.ts — overlay upstream saturation onto percent dimensions
 * of a PoolUsageSnapshot.
 *
 * `percent` dimensions are never written to quota_consumption (costForUnit
 * returns 0 for them — enforce.ts), so a snapshot built purely from the store
 * shows 0% forever for percent-only plans (claude/codex/bailian). Enforcement
 * derives their consumption from the saturation signal instead; this helper
 * applies the SAME semantics to the REST snapshot so the dashboard matches
 * what enforce.ts actually acts on:
 *
 *   limit          = per-account plan limit × connection count (accountCount)
 *   consumedTotal  = Σ_connection (saturation × per-account limit)
 *
 * Fail-open (B16): a saturation error for a connection contributes 0 for that
 * connection; if every connection fails the dimension keeps its stored value.
 */

import type { PoolUsageSnapshot } from "./types";
import type { QuotaUnit, QuotaWindow } from "./dimensions";

interface SaturationDim {
  unit: QuotaUnit;
  window: QuotaWindow;
}

export interface ApplyPercentSaturationOptions {
  /** All member connections of the pool (accountCount = connectionIds.length). */
  connectionIds: string[];
  provider: string;
  /** Saturation reader (0..1) — injectable for tests; production passes getSaturation. */
  getSaturation: (connectionId: string, provider: string, dim: SaturationDim) => Promise<number>;
}

/**
 * Return a copy of `snapshot` where every `percent` dimension's limit and
 * consumedTotal reflect the upstream saturation signal. Non-percent dimensions
 * are returned unchanged.
 */
export async function applyPercentSaturation(
  snapshot: PoolUsageSnapshot,
  options: ApplyPercentSaturationOptions
): Promise<PoolUsageSnapshot> {
  const connectionIds = options.connectionIds.filter((id) => typeof id === "string" && id !== "");
  if (connectionIds.length === 0) return snapshot;

  const dimensions = await Promise.all(
    snapshot.dimensions.map(async (dim) => {
      if (dim.unit !== "percent") return dim;

      const spec: SaturationDim = { unit: dim.unit, window: dim.window };
      let consumedTotal = 0;
      let anySignal = false;

      for (const connectionId of connectionIds) {
        try {
          const saturation = await options.getSaturation(connectionId, options.provider, spec);
          if (Number.isFinite(saturation)) {
            consumedTotal += Math.min(1, Math.max(0, saturation)) * dim.limit;
            anySignal = true;
          }
        } catch {
          // fail-open per B16 — this connection contributes nothing
        }
      }

      if (!anySignal) return dim;

      return {
        ...dim,
        limit: dim.limit * connectionIds.length,
        consumedTotal,
      };
    })
  );

  return { ...snapshot, dimensions };
}
