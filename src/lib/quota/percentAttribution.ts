/**
 * percentAttribution.ts — attribute the ACCOUNT-level percent utilization to
 * individual API keys, proportionally to their share of the pool's proxied
 * token traffic.
 *
 * The provider reports only one number per window (e.g. "account 92% used");
 * it cannot split it by OmniRoute API key. The tokens/<window> telemetry
 * buckets (written per key by recordConsumption) give each key's share of the
 * traffic that went THROUGH OmniRoute, so:
 *
 *   consumedByKey(percent) = accountPercentConsumed × keyTokens / poolTokens
 *
 * Known limit: traffic that bypasses the proxy (e.g. the CLI used directly
 * with the same account) is visible only in the account total and gets spread
 * across keys proportionally to their proxy traffic — the provider offers no
 * finer signal.
 *
 * Fail-open: on any store error, or when the pool has no token telemetry for
 * the window, the share is 0 (pre-attribution behaviour: consumed stays 0).
 */

import type { QuotaWindow } from "./dimensions";

interface TokenPeekStore {
  peek(
    apiKeyId: string,
    dim: { poolId: string; unit: "tokens"; window: QuotaWindow }
  ): Promise<number>;
  poolConsumedTotal(
    poolId: string,
    dim: { poolId: string; unit: "tokens"; window: QuotaWindow }
  ): Promise<number>;
}

/**
 * Share (0..1) of the pool's token telemetry attributable to `apiKeyId` in
 * the given window. 0 when the pool window has no telemetry at all.
 */
export async function poolTokenShare(
  store: TokenPeekStore,
  poolId: string,
  apiKeyId: string,
  window: QuotaWindow
): Promise<number> {
  const dim = { poolId, unit: "tokens" as const, window };
  try {
    const poolTokens = await store.poolConsumedTotal(poolId, dim);
    if (!(poolTokens > 0)) return 0;
    const keyTokens = await store.peek(apiKeyId, dim);
    if (!(keyTokens > 0)) return 0;
    return Math.min(1, keyTokens / poolTokens);
  } catch {
    return 0; // fail-open per B16
  }
}
