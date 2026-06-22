/**
 * build-assets tests — guard the runtime data assets apps/api's esbuild build
 * copies next to the serverless function.
 *
 * Regression context: esbuild inlines JS/TS but NOT data files. The built-in
 * connector schema YAMLs are read at runtime by @oxagen/ingestion's
 * loadBuiltInSchema (plugin.schema.get → connector install / "Configure" forms).
 * If build.mjs stops copying them, every connector "Configure" click 500s in
 * prod while passing locally (tsx reads source directly). These tests lock the
 * copy plan in place.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
// @ts-expect-error — .mjs build helper has no type declarations; imported for test only.
import { connectorSchemaAssets } from "../../build-assets.mjs";

interface Asset {
  src: string;
  dest: string;
}

describe("connectorSchemaAssets (apps/api build)", () => {
  const assets = connectorSchemaAssets() as Asset[];

  it("includes the built-in connector schemas the runtime reads", () => {
    const dests = assets.map((a) => a.dest);
    for (const id of ["github", "google-drive", "linear", "slack"]) {
      expect(dests).toContain(`connectors/${id}/schema.yaml`);
    }
  });

  it("points every asset at a source file that exists on disk", () => {
    expect(assets.length).toBeGreaterThan(0);
    for (const a of assets) {
      expect(existsSync(a.src), `${a.src} should exist`).toBe(true);
    }
  });

  it("emits dests preserving the connectors/<id>/ layout the loader expects", () => {
    for (const a of assets) {
      expect(a.dest).toMatch(/^connectors\/[^/]+\/schema\.yaml$/);
    }
  });
});
