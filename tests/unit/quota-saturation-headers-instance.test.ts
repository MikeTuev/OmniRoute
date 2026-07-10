/**
 * tests/unit/quota-saturation-headers-instance.test.ts
 *
 * Bug: chatCore passes `providerResponse.headers` (a Fetch `Headers` instance)
 * to storeRateLimitHeaders, which reads keys via plain index access
 * (`headers["anthropic-ratelimit-tokens-limit"]`). On a `Headers` object that
 * is always `undefined`, so NO rate-limit signal was ever cached and the
 * anthropic/claude saturation signal permanently failed open to 0.
 *
 * These tests pass a real `Headers` instance (exactly what the call site in
 * open-sse/handlers/chatCore.ts sends) and assert the token signal is stored.
 * The plain-record path is also asserted to prevent a regression.
 */

import test from "node:test";
import assert from "node:assert/strict";

const satMod = await import("../../src/lib/quota/saturationSignals.ts");
const {
  storeRateLimitHeaders,
  getTokenHeaderSaturation,
  _clearSaturationCache,
  _clearRateLimitHeaders,
} = satMod;

test.afterEach(() => {
  _clearSaturationCache();
  _clearRateLimitHeaders();
});

test("storeRateLimitHeaders: accepts a Fetch Headers instance (chatCore call site)", () => {
  _clearRateLimitHeaders();

  const headers = new Headers({
    "anthropic-ratelimit-tokens-limit": "1000",
    "anthropic-ratelimit-tokens-remaining": "250",
    "anthropic-ratelimit-tokens-reset": "2026-01-01T00:00:30Z",
  });

  storeRateLimitHeaders("conn-hdr-1", "anthropic", headers as unknown as Record<string, string>);

  const sig = getTokenHeaderSaturation("anthropic", "conn-hdr-1");
  assert.ok(sig, "expected a token-header signal from a Headers instance");
  assert.ok(
    Math.abs(sig!.saturation - 0.75) < 1e-9,
    `expected saturation ≈0.75, got ${sig!.saturation}`
  );
});

test("storeRateLimitHeaders: Headers instance with mixed-case keys is normalized", () => {
  _clearRateLimitHeaders();

  // Headers normalizes key case internally; ensure our read path relies on that.
  const headers = new Headers();
  headers.set("Anthropic-Ratelimit-Tokens-Limit", "200");
  headers.set("Anthropic-Ratelimit-Tokens-Remaining", "50");

  storeRateLimitHeaders("conn-hdr-2", "anthropic", headers as unknown as Record<string, string>);

  const sig = getTokenHeaderSaturation("anthropic", "conn-hdr-2");
  assert.ok(sig, "expected a token-header signal from mixed-case Headers");
  assert.ok(Math.abs(sig!.saturation - 0.75) < 1e-9, `expected ≈0.75, got ${sig!.saturation}`);
});

test("storeRateLimitHeaders: plain record still works (no regression)", () => {
  _clearRateLimitHeaders();

  storeRateLimitHeaders("conn-hdr-3", "anthropic", {
    "anthropic-ratelimit-tokens-limit": "100",
    "anthropic-ratelimit-tokens-remaining": "80",
  });

  const sig = getTokenHeaderSaturation("anthropic", "conn-hdr-3");
  assert.ok(sig, "expected a token-header signal from a plain record");
  assert.ok(Math.abs(sig!.saturation - 0.2) < 1e-9, `expected ≈0.2, got ${sig!.saturation}`);
});
