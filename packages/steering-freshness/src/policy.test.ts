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

  it("unions the excludes rather than replacing them", () => {
    const policy = resolveSteeringPolicy([
      { scope: "project", policy: { exclude: [".oxagen/scratch"] } },
      { scope: "local", policy: { exclude: [".oxagen/notes"] } },
    ]);
    expect(policy.exclude).toEqual([
      ".oxagen/notes",
      ".oxagen/scratch",
      ".oxagen/settings.local.json",
    ]);
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
