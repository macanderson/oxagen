import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  capabilityRow,
  capabilityTable,
  cloudModel,
  cloudModelIds,
  expandHome,
  loadRegistry,
  registryDefaults,
  roles,
} from "../registry.js";

describe("loadRegistry / defaults", () => {
  it("exposes the runtime defaults from models.json", () => {
    const d = registryDefaults();
    expect(d.coordinator).toBe("on-device");
    expect(d.onDevice.autoDownload).toBe(true);
    expect(d.onDevice.modelId).toBe("auto");
    expect(d.onDevice.quantizationPreference).toEqual(["q8", "q6", "q5", "q4"]);
  });

  it("ships a non-empty capability table with download sources", () => {
    const reg = loadRegistry();
    expect(reg.capabilityTable.rows.length).toBeGreaterThan(0);
    for (const row of reg.capabilityTable.rows) {
      expect(row.codeScore).toBeGreaterThan(0);
      expect(row.quantizations.length).toBeGreaterThan(0);
      // Every on-device row must be provisionable (has a source per quant).
      for (const q of row.quantizations) {
        expect(row.sources?.[q]?.url).toMatch(/^https:\/\//);
      }
    }
  });
});

describe("capabilityTable", () => {
  it("is sorted by codeScore descending", () => {
    const rows = capabilityTable();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.codeScore).toBeGreaterThanOrEqual(rows[i]!.codeScore);
    }
  });

  it("looks up a row by modelId", () => {
    const top = capabilityTable()[0]!;
    expect(capabilityRow(top.modelId)?.modelId).toBe(top.modelId);
    expect(capabilityRow("nope")).toBeUndefined();
  });
});

describe("cloudModel", () => {
  afterEach(() => {
    delete process.env["OXAGEN_MODEL_HAIKU"];
  });

  it("resolves known cloud ids to gateway slugs", () => {
    expect(cloudModel("haiku")?.slug).toMatch(/anthropic\//);
    expect(cloudModel("openai-most-capable-coding-model")?.vendor).toBe(
      "openai",
    );
    expect(cloudModel("unknown")).toBeUndefined();
  });

  it("lets an env var override a gateway slug (drift-proofing)", () => {
    process.env["OXAGEN_MODEL_HAIKU"] = "anthropic/claude-haiku-9.9";
    expect(cloudModel("haiku")?.slug).toBe("anthropic/claude-haiku-9.9");
  });

  it("lists every cloud id and the registry roles", () => {
    expect(cloudModelIds()).toEqual(
      expect.arrayContaining(["haiku", "sonnet-5"]),
    );
    expect(roles().workerModels.defaultCode).toBe("sonnet-5");
    expect(roles().coordinatorCandidates).toContain("on-device");
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/… but leaves absolute paths alone", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/.oxagen/models")).toBe(
      join(homedir(), ".oxagen/models"),
    );
    expect(expandHome("/tmp/x")).toBe("/tmp/x");
  });
});
