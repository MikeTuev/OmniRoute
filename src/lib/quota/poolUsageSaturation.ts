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
  /**
   * Optional per-key token share (0..1) for a window — same attribution the
   * enforcement path uses (poolTokenShare): the account-level percent is split
   * across keys by their share of the pool's token telemetry. When absent the
   * perKey entries are left at their stored values (0 for percent).
   */
  getTokenShare?: (apiKeyId: string, window: QuotaWindow) => Promise<number>;
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

      const scaledLimit = dim.limit * connectionIds.length;

      // Per-key attribution (mirrors enforce.ts): split the account-level
      // percent across keys by their token-telemetry share, so the Consumed /
      // Deficit columns and the per-key slices reflect the same numbers the
      // fair-share gate acts on. fairShare stays weight-based (weight% of the
      // per-account limit, matching poolUsageWithDimensions).
      let perKey = dim.perKey;
      if (options.getTokenShare && Array.isArray(perKey) && perKey.length > 0) {
        perKey = await Promise.all(
          perKey.map(async (entry) => {
            try {
              const share = await options.getTokenShare!(entry.apiKeyId, dim.window);
              if (!Number.isFinite(share) || share <= 0) return entry;
              const consumed = consumedTotal * Math.min(1, share);
              return {
                ...entry,
                consumed,
                deficit: consumed - entry.fairShare,
                borrowing: consumed > entry.fairShare,
              };
            } catch {
              return entry; // fail-open per B16
            }
          })
        );
      }

      return {
        ...dim,
        limit: scaledLimit,
        consumedTotal,
        perKey,
      };
    })
  );

  return { ...snapshot, dimensions };
}
