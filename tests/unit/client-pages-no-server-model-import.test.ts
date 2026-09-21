import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(REPO_ROOT, "src/app");

/**
 * `open-sse/services/model.ts` dynamically imports `@/lib/db/models/activeSyncedCatalog`,
 * which transitively pulls the whole SQLite/ioredis/playwright chain. When a `"use client"`
 * module imports it, Turbopack bundles that chain for the browser and `next build` fails
 * with `Module not found: Can't resolve 'tls' | 'fs' | 'child_process' | ...`.
 *
 * Regression guard for the combos page (#13951 regressed it).
 */
const FORBIDDEN_IMPORT = /from\s+["']@omniroute\/open-sse\/services\/model(\.ts)?["']/;

function collectClientModules(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectClientModules(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    const source = readFileSync(full, "utf8");
    if (/^\s*["']use client["'];/m.test(source)) out.push(full);
  }
  return out;
}

describe("client components must not import the server-only model service", () => {
  it('keeps @omniroute/open-sse/services/model.ts out of every "use client" module', () => {
    const offenders = collectClientModules(APP_DIR).filter((file) =>
      FORBIDDEN_IMPORT.test(readFileSync(file, "utf8"))
    );

    assert.deepEqual(
      offenders.map((f) => path.relative(REPO_ROOT, f)),
      [],
      "use resolveProviderAlias from @omniroute/open-sse/services/providerAlias.ts instead — " +
        "services/model.ts drags server-only DB modules into the browser bundle"
    );
  });
});
