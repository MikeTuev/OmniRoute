import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate the feature-flag DB to a temp dir before importing modules that touch it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-afk-"));
process.env.DATA_DIR = tmpDir;
delete process.env.CLAUDE_FORWARD_AFK_BETA;

await import("../../src/lib/db/core.ts");
const { selectBetaFlags } = await import("../../open-sse/executors/claudeIdentity.ts");
const { setFeatureFlagOverride, clearAllFeatureFlagOverrides } = await import(
  "../../src/lib/db/featureFlags.ts"
);

const AFK = "afk-mode-2026-01-31";

function opusFullAgentBody() {
  return {
    model: "claude-opus-4-8",
    system: "You are a coding agent.",
    tools: [{ name: "Bash", description: "run a command", input_schema: { type: "object" } }],
  };
}

const clientWithAfk = {
  "anthropic-beta": "claude-code-20250219,afk-mode-2026-01-31,effort-2025-11-24",
};

function enableFlag() {
  setFeatureFlagOverride("CLAUDE_FORWARD_AFK_BETA", "true");
}

function reset() {
  clearAllFeatureFlagOverrides();
}

test("afk: default (flag off) does not forward afk-mode even when client sends it", () => {
  reset();
  const flags = selectBetaFlags(opusFullAgentBody(), null, clientWithAfk);
  assert.ok(!flags.includes(AFK), "afk-mode must NOT be forwarded by default");
});

test("afk: flag on + client sent afk-mode → forwarded", () => {
  enableFlag();
  try {
    const flags = selectBetaFlags(opusFullAgentBody(), null, clientWithAfk);
    assert.ok(flags.includes(AFK), "afk-mode should be forwarded when opted in and client sent it");
  } finally {
    reset();
  }
});

test("afk: flag on + client did NOT send afk-mode → not forwarded", () => {
  enableFlag();
  try {
    const flags = selectBetaFlags(opusFullAgentBody(), null, {
      "anthropic-beta": "claude-code-20250219,effort-2025-11-24",
    });
    assert.ok(!flags.includes(AFK), "afk-mode must not be invented when the client did not send it");
  } finally {
    reset();
  }
});

test("afk: flag on + no client headers → not forwarded (no crash)", () => {
  enableFlag();
  try {
    const flags = selectBetaFlags(opusFullAgentBody());
    assert.ok(!flags.includes(AFK));
  } finally {
    reset();
  }
});

test("afk: header lookup is case-insensitive (Anthropic-Beta)", () => {
  enableFlag();
  try {
    const flags = selectBetaFlags(opusFullAgentBody(), null, {
      "Anthropic-Beta": "afk-mode-2026-01-31",
    });
    assert.ok(flags.includes(AFK), "must read afk-mode from a capitalized header name too");
  } finally {
    reset();
  }
});

test("afk: not forwarded for non-heavy-agent models (Haiku) even with flag + client", () => {
  enableFlag();
  try {
    const flags = selectBetaFlags(
      { ...opusFullAgentBody(), model: "claude-haiku-4-5-20251001" },
      null,
      clientWithAfk
    );
    assert.ok(!flags.includes(AFK), "afk-mode is gated to heavy-agent (Opus/Sonnet) shapes");
  } finally {
    reset();
  }
});
