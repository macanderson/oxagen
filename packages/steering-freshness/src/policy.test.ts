import { describe, expect, it } from "vitest";
import {
  autoSyncActive,
  blockingActive,
  readEmergencyOverride,
  resolveSteeringPolicy,
  steeringPolicyFileSchema,
  type PolicyLayer,
} from "./policy";

describe("resolveSteeringPolicy", () => {
  it("defaults both gates off", () => {
    const policy = resolveSteeringPolicy([]);
    expect(policy.autoSync).toBe(false);
    expect(policy.blockStaleRuns).toBe(false);
    expect(policy.remote).toBe("origin");
    expect(policy.branch).toBeNull();
  });

  it("records which scope switched a gate on", () => {
    const policy = resolveSteeringPolicy([
      { scope: "project", policy: { blockStaleRuns: true } },
    ]);
    expect(policy.blockStaleRuns).toBe(true);
    expect(policy.sources.blockStaleRuns).toBe("project");
    expect(policy.sources.autoSync).toBeNull();
  });

  // The rule the whole design rests on: a personal file cannot switch off a
  // gate the team or the workspace switched on.
  it("refuses to let a later scope turn a gate off", () => {
    const layers: PolicyLayer[] = [
      { scope: "project", policy: { blockStaleRuns: true, autoSync: true } },
      { scope: "local", policy: { blockStaleRuns: false, autoSync: false } },
    ];
    const policy = resolveSteeringPolicy(layers);
    expect(policy.blockStaleRuns).toBe(true);
    expect(policy.autoSync).toBe(true);
    expect(policy.sources.blockStaleRuns).toBe("project");
  });

  it("lets a later scope turn a gate on", () => {
    const policy = resolveSteeringPolicy([
      { scope: "project", policy: { blockStaleRuns: false } },
      { scope: "local", policy: { blockStaleRuns: true } },
    ]);
    expect(policy.blockStaleRuns).toBe(true);
    expect(policy.sources.blockStaleRuns).toBe("local");
  });

  it("applies scopes in precedence order however they arrive", () => {
    const policy = resolveSteeringPolicy([
      { scope: "workspace", policy: { remote: "upstream" } },
      { scope: "user", policy: { remote: "fork" } },
    ]);
    expect(policy.remote).toBe("upstream");
  });

  it("lets the scalars overwrite, because they carry no authority", () => {
    const policy = resolveSteeringPolicy([
      { scope: "user", policy: { branch: "main", fetchIntervalSeconds: 60 } },
      {
        scope: "project",
        policy: { branch: "release", fetchIntervalSeconds: 5 },
      },
    ]);
    expect(policy.branch).toBe("release");
    expect(policy.fetchIntervalSeconds).toBe(5);
  });

  it("unions the excludes of the reviewed scopes rather than replacing them", () => {
    const policy = resolveSteeringPolicy([
      { scope: "project", policy: { exclude: [".oxagen/scratch"] } },
      { scope: "workspace", policy: { exclude: [".oxagen/vendor"] } },
    ]);
    expect(policy.exclude).toEqual([
      ".oxagen/scratch",
      ".oxagen/settings.local.json",
      ".oxagen/vendor",
    ]);
  });

  // `~/.config/oxagen/settings.json` is exactly as personal as the local
  // file. Refusing only `local` moved the off switch one directory up.
  it("refuses an exclusion written in the user settings file too", () => {
    const policy = resolveSteeringPolicy([
      { scope: "workspace", policy: { blockStaleRuns: true } },
      { scope: "user", policy: { exclude: [".oxagen/rules"] } },
    ]);
    expect(policy.exclude).toEqual([".oxagen/settings.local.json"]);
    expect(policy.refusedExcludes).toEqual([".oxagen/rules"]);
  });

  // `.oxagen/settings.local.json` is personal and gitignored. An exclusion
  // written there filters records out of the comparison, so one line nobody
  // else can read — `.oxagen/rules` — makes every missing record vanish and
  // the verdict come back `current` with `blockStaleRuns` still on. That is
  // the gate's off switch, held by the one scope the workspace cannot see.
  it("refuses an exclusion written in the personal settings file", () => {
    const policy = resolveSteeringPolicy([
      { scope: "workspace", policy: { blockStaleRuns: true } },
      { scope: "local", policy: { exclude: [".oxagen/rules"] } },
    ]);
    expect(policy.exclude).toEqual([".oxagen/settings.local.json"]);
    expect(policy.refusedExcludes).toEqual([".oxagen/rules"]);
    expect(policy.blockStaleRuns).toBe(true);
  });

  // Refused whatever the workspace has switched on, so the setting means the
  // same thing on every machine rather than changing meaning with the gates.
  it("refuses a personal exclusion even with no gate active", () => {
    const policy = resolveSteeringPolicy([
      { scope: "local", policy: { exclude: [".oxagen/rules"] } },
    ]);
    expect(policy.exclude).toEqual([".oxagen/settings.local.json"]);
    expect(policy.refusedExcludes).toEqual([".oxagen/rules"]);
  });

  // Nothing to report when a reviewed scope already excludes the same path:
  // the personal file is then redundant, not defeated.
  it("reports nothing when a reviewed scope already excludes the path", () => {
    const policy = resolveSteeringPolicy([
      { scope: "project", policy: { exclude: [".oxagen/scratch"] } },
      { scope: "local", policy: { exclude: [".oxagen/scratch"] } },
    ]);
    expect(policy.exclude).toContain(".oxagen/scratch");
    expect(policy.refusedExcludes).toEqual([]);
  });

  it("always excludes the personal settings file", () => {
    const policy = resolveSteeringPolicy([
      { scope: "project", policy: { exclude: [] } },
    ]);
    expect(policy.exclude).toContain(".oxagen/settings.local.json");
  });

  it("marks the policy suspended without forgetting what was configured", () => {
    const policy = resolveSteeringPolicy(
      [{ scope: "workspace", policy: { blockStaleRuns: true } }],
      { suspended: true, reason: "because" },
    );
    expect(policy.blockStaleRuns).toBe(true);
    expect(policy.suspended).toBe(true);
    expect(blockingActive(policy)).toBe(false);
  });
});

describe("blockingActive / autoSyncActive", () => {
  it("are true only when configured and not suspended", () => {
    const on = resolveSteeringPolicy([
      { scope: "project", policy: { blockStaleRuns: true, autoSync: true } },
    ]);
    expect(blockingActive(on)).toBe(true);
    expect(autoSyncActive(on)).toBe(true);

    const off = resolveSteeringPolicy([]);
    expect(blockingActive(off)).toBe(false);
    expect(autoSyncActive(off)).toBe(false);
  });
});

describe("readEmergencyOverride", () => {
  it.each(["0", "off", "false", "no", "OFF", " Off "])(
    "suspends on %s",
    (value) => {
      expect(
        readEmergencyOverride({ OXAGEN_STEERING_FRESHNESS: value }).suspended,
      ).toBe(true);
    },
  );

  it.each([undefined, "", "1", "on", "true", "yes", "maybe"])(
    "does not suspend on %s",
    (value) => {
      expect(
        readEmergencyOverride({ OXAGEN_STEERING_FRESHNESS: value }).suspended,
      ).toBe(false);
    },
  );

  it("names itself in the reason so a banner can say why", () => {
    const { reason } = readEmergencyOverride({
      OXAGEN_STEERING_FRESHNESS: "off",
    });
    expect(reason).toContain("OXAGEN_STEERING_FRESHNESS");
  });
});

describe("steeringPolicyFileSchema", () => {
  it("rejects an unknown key rather than ignoring a typo", () => {
    const result = steeringPolicyFileSchema.safeParse({ blockStaleRun: true });
    expect(result.success).toBe(false);
  });

  it("accepts a null branch, which means resolve the default", () => {
    expect(steeringPolicyFileSchema.safeParse({ branch: null }).success).toBe(
      true,
    );
  });

  it("rejects a negative fetch interval", () => {
    expect(
      steeringPolicyFileSchema.safeParse({ fetchIntervalSeconds: -1 }).success,
    ).toBe(false);
  });
});
