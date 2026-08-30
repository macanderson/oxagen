/**
 * Model catalog — proves the CLI has exactly one source of truth for the
 * latest-GA slug of every model family, that every default resolves to it, and
 * that no stale slug can creep back into the tree.
 *
 * This is the anti-drift ratchet: Sonnet once appeared as 4.5, 4.6, and 5
 * simultaneously across the CLI. These tests fail the instant a default drifts
 * off the catalog or a hard-coded legacy Sonnet slug reappears anywhere.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Pin readConfig to empty so DEFAULT_MODEL's resolution never picks up a
// developer's real ~/.config/oxagen/config.json `model` pin.
vi.mock("../../lib/config.js", () => ({ readConfig: () => ({}) }));

import {
  LATEST_ANTHROPIC,
  LATEST_OPENAI_CODING,
  DEFAULT_CODING_MODEL,
} from "../model-catalog.js";
import { modelForTier } from "../model-router.js";
import { DEFAULT_MODEL } from "../model.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = resolve(HERE, "../..");

// Clear per-env tier overrides so we test the code's catalog default, not a
// developer's shell pin (OXAGEN_LLM_BALANCED etc. legitimately override it).
beforeEach(() => {
  for (const key of [
    "OXAGEN_LLM_FAST",
    "OXAGEN_LLM_BALANCED",
    "OXAGEN_LLM_PRECISE",
    "OXAGEN_MODEL",
  ]) {
    delete process.env[key];
  }
});

// The registry JSON is a second declaration of the same slugs (it's data, not
// code, so it can't import the catalog). This mapping is the contract the test
// enforces: every friendly id below must carry the catalog's slug.
const REGISTRY_EXPECTATIONS: Record<string, string> = {
  haiku: LATEST_ANTHROPIC.haiku,
  "sonnet-5": LATEST_ANTHROPIC.sonnet,
  fable: LATEST_ANTHROPIC.fable,
  "openai-most-capable-coding-model": LATEST_OPENAI_CODING,
};

describe("model catalog is the single source of truth", () => {
  it("every tier default resolves to the catalog", () => {
    expect(modelForTier("fast")).toBe(LATEST_ANTHROPIC.haiku);
    expect(modelForTier("balanced")).toBe(LATEST_ANTHROPIC.sonnet);
    expect(modelForTier("precise")).toBe(LATEST_ANTHROPIC.fable);
  });

  it("the agent-loop default is the catalog's balanced/Sonnet slug", () => {
    expect(DEFAULT_MODEL).toBe(DEFAULT_CODING_MODEL);
    expect(DEFAULT_MODEL).toBe(LATEST_ANTHROPIC.sonnet);
  });

  it("the runtime registry slugs match the catalog", () => {
    const models = JSON.parse(
      readFileSync(join(CLI_SRC, "runtime", "models.json"), "utf8"),
    ) as { cloudModels: Record<string, { slug: string }> };
    for (const [id, slug] of Object.entries(REGISTRY_EXPECTATIONS)) {
      expect(models.cloudModels[id]?.slug, `cloudModels.${id}`).toBe(slug);
    }
  });
});

describe("no stale Sonnet slug survives anywhere in the CLI source", () => {
  // Legacy Sonnet slugs that must never reappear now that Sonnet 5 is GA.
  const FORBIDDEN = ["claude-sonnet-4.5", "claude-sonnet-4.6"];

  function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "__tests__")
        continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) yield* walk(full);
      else if (/\.(ts|tsx|json)$/.test(name)) yield full;
    }
  }

  it("no source file hard-codes a legacy Sonnet slug", () => {
    const offenders: string[] = [];
    for (const file of walk(CLI_SRC)) {
      const text = readFileSync(file, "utf8");
      for (const bad of FORBIDDEN) {
        if (text.includes(bad))
          offenders.push(`${file.replace(CLI_SRC, "src")} → ${bad}`);
      }
    }
    expect(
      offenders,
      `stale Sonnet slugs found:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
