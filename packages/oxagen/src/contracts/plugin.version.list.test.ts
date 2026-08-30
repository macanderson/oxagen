import { describe, expect, it } from "vitest";
import { pluginVersionList } from "./plugin.version.list";
import { getCapability } from "../registry";

// ── helpers ───────────────────────────────────────────────────────────────────

const minimalVersion = {
  version: "1.3.0",
  releasedAt: "2024-01-01T00:00:00.000Z",
  isBreaking: false,
  schemaVersion: "v1",
};

const minimalOutput = {
  pluginId: "github",
  currentVersion: "1.3.0",
  installedVersion: "1.2.0",
  hasBreakingUpdate: false,
  versions: [minimalVersion],
};

describe("plugin.version.list capability", () => {
  // ── input defaults ────────────────────────────────────────────────────────

  it("defaults limit to 20", () => {
    const parsed = pluginVersionList.input.parse({ pluginId: "github" });
    expect(parsed.limit).toBe(20);
  });

  it("defaults includeChangelog to false", () => {
    const parsed = pluginVersionList.input.parse({ pluginId: "github" });
    expect(parsed.includeChangelog).toBe(false);
  });

  // ── input: pluginId ───────────────────────────────────────────────────────

  it("accepts a valid pluginId", () => {
    const parsed = pluginVersionList.input.parse({ pluginId: "google-drive" });
    expect(parsed.pluginId).toBe("google-drive");
  });

  it("rejects input missing pluginId", () => {
    expect(() => pluginVersionList.input.parse({})).toThrow();
  });

  it("rejects non-string pluginId", () => {
    expect(() => pluginVersionList.input.parse({ pluginId: 42 })).toThrow();
  });

  // ── input: limit bounds ───────────────────────────────────────────────────

  it("accepts limit=1 (min)", () => {
    const parsed = pluginVersionList.input.parse({
      pluginId: "github",
      limit: 1,
    });
    expect(parsed.limit).toBe(1);
  });

  it("accepts limit=50 (max)", () => {
    const parsed = pluginVersionList.input.parse({
      pluginId: "github",
      limit: 50,
    });
    expect(parsed.limit).toBe(50);
  });

  it("rejects limit=0 (below min)", () => {
    expect(() =>
      pluginVersionList.input.parse({ pluginId: "github", limit: 0 }),
    ).toThrow();
  });

  it("rejects limit=51 (above max)", () => {
    expect(() =>
      pluginVersionList.input.parse({ pluginId: "github", limit: 51 }),
    ).toThrow();
  });

  it("rejects a non-integer limit", () => {
    expect(() =>
      pluginVersionList.input.parse({ pluginId: "github", limit: 1.5 }),
    ).toThrow();
  });

  // ── input: includeChangelog ───────────────────────────────────────────────

  it("accepts includeChangelog=true", () => {
    const parsed = pluginVersionList.input.parse({
      pluginId: "github",
      includeChangelog: true,
    });
    expect(parsed.includeChangelog).toBe(true);
  });

  // ── output: valid minimal shape ───────────────────────────────────────────

  it("parses a minimal valid output", () => {
    const parsed = pluginVersionList.output.parse(minimalOutput);
    expect(parsed.pluginId).toBe("github");
    expect(parsed.currentVersion).toBe("1.3.0");
    expect(parsed.installedVersion).toBe("1.2.0");
    expect(parsed.hasBreakingUpdate).toBe(false);
    expect(parsed.versions).toHaveLength(1);
  });

  it("parses output with installedVersion=null (plugin not installed)", () => {
    const parsed = pluginVersionList.output.parse({
      ...minimalOutput,
      installedVersion: null,
    });
    expect(parsed.installedVersion).toBeNull();
  });

  it("parses output with an empty versions array", () => {
    const parsed = pluginVersionList.output.parse({
      ...minimalOutput,
      versions: [],
    });
    expect(parsed.versions).toHaveLength(0);
  });

  // ── output: version entry optional fields ─────────────────────────────────

  it("parses a version entry with optional breakingChanges", () => {
    const parsed = pluginVersionList.output.parse({
      ...minimalOutput,
      versions: [
        {
          ...minimalVersion,
          isBreaking: true,
          breakingChanges: ["Removed the `foo` config field"],
        },
      ],
    });
    expect(parsed.versions[0]?.isBreaking).toBe(true);
    expect(parsed.versions[0]?.breakingChanges).toEqual([
      "Removed the `foo` config field",
    ]);
  });

  it("parses a version entry with optional changelog", () => {
    const parsed = pluginVersionList.output.parse({
      ...minimalOutput,
      versions: [
        {
          ...minimalVersion,
          changelog: "## 1.3.0\n- Added org filter support",
        },
      ],
    });
    expect(parsed.versions[0]?.changelog).toContain("org filter");
  });

  it("parses a version entry with optional minimumPlatformVersion", () => {
    const parsed = pluginVersionList.output.parse({
      ...minimalOutput,
      versions: [
        {
          ...minimalVersion,
          minimumPlatformVersion: "2.1.0",
        },
      ],
    });
    expect(parsed.versions[0]?.minimumPlatformVersion).toBe("2.1.0");
  });

  it("parses a version entry without optional fields (all undefined)", () => {
    const parsed = pluginVersionList.output.parse({
      ...minimalOutput,
      versions: [minimalVersion],
    });
    expect(parsed.versions[0]?.breakingChanges).toBeUndefined();
    expect(parsed.versions[0]?.changelog).toBeUndefined();
    expect(parsed.versions[0]?.minimumPlatformVersion).toBeUndefined();
  });

  // ── output: invalid cases ─────────────────────────────────────────────────

  it("rejects output missing pluginId", () => {
    expect(() =>
      pluginVersionList.output.parse({
        currentVersion: "1.0.0",
        installedVersion: null,
        hasBreakingUpdate: false,
        versions: [],
      }),
    ).toThrow();
  });

  it("rejects output missing currentVersion", () => {
    expect(() =>
      pluginVersionList.output.parse({
        pluginId: "github",
        installedVersion: null,
        hasBreakingUpdate: false,
        versions: [],
      }),
    ).toThrow();
  });

  it("rejects a version entry missing the required version field", () => {
    expect(() =>
      pluginVersionList.output.parse({
        ...minimalOutput,
        versions: [
          {
            releasedAt: "2024-01-01T00:00:00.000Z",
            isBreaking: false,
            schemaVersion: "v1",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a version entry missing schemaVersion", () => {
    expect(() =>
      pluginVersionList.output.parse({
        ...minimalOutput,
        versions: [
          {
            version: "1.0.0",
            releasedAt: "2024-01-01T00:00:00.000Z",
            isBreaking: false,
          },
        ],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_plugin_versions")).toBe(pluginVersionList);
  });
});
