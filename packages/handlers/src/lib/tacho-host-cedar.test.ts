/**
 * The Cedar part of a host's signed bundle (lane S12, #4445). The workspace's
 * published steering version is compiled once, cut down to the agents on the
 * host's runtime, signed into the bundle, verified on the host, and decided
 * in PreToolUse. Nothing published gives a bundle without Cedar, and a newly
 * published version moves the etag.
 */
import { generateKeyPairSync } from "node:crypto";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  type CedarRuntime,
  type CompiledPolicySet,
  requireCedarRuntime,
} from "@oxagen/policy";
import { BUNDLE_FEATURE_CEDAR, policyBundleSchema } from "@oxagen/recorder";
import {
  evaluatePreToolUse,
  verifyBundle as verifyOnHost,
} from "@oxagen/recorder/host";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTHING_PUBLISHED, type TachoPublished } from "../tacho.published";
import { bundleSignerFromPem } from "./tacho-bundle-signing";
import {
  resolveHostCedar,
  signBundle,
  type TachoHostRow,
  unsignedBundle,
} from "./tacho-host";
import {
  CedarPoliciesUnavailableError,
  createHostCedarReader,
  hostCedarReader,
  readCedarForEnvelope,
} from "./tacho-host-cedar";
import {
  BROKEN_POLICY,
  CEDAR_RUNTIME,
  CI_BOT,
  cedarPort,
  cedarVersion,
  NO_SHELL_ID,
  RELEASE_BOT,
  REVIEWER,
  REVIEWER_NO_SHELL_ID,
} from "./tacho-host-cedar.test-support";
import { assembleWorkspaceSteering } from "./tacho-steering";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger", () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const PEM = generateKeyPairSync("ed25519")
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const NOW = new Date("2026-10-02T12:00:00.000Z");
const HOST_PUBLIC = "tch_0123456789abcdefghjkmn";
const CTX: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: null,
  apiKeyId: "aky_host",
  requestId: "req_1",
  surface: "api",
  messageId: null,
};
const NO_MANDATE = {
  permissions: { allow: [], deny: [], ask: [] },
  budget: { mode: "observed" as const },
};
const RETENTION = { mode: "digest_only" as const, classes: [] };
const STEERING = assembleWorkspaceSteering("org", "ws", []);
const DENY_GENERATION = { org: 1, workspace: 1 };

let runtime: CedarRuntime;

beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

beforeEach(() => {
  warn.mockClear();
});

/** An enforcing host that parses Cedar and binds a runtime. */
function hostRow(overrides: Record<string, unknown> = {}): TachoHostRow {
  return {
    publicId: HOST_PUBLIC,
    status: "active",
    mode: "enforce",
    bundleVersionServed: 1,
    bundleFeatures: [BUNDLE_FEATURE_CEDAR],
    runtimeId: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  } as unknown as TachoHostRow;
}

/**
 * A transaction whose runtimes read answers `slug`, counting the reads.
 * `null` means the runtime is not found. Passing `undefined` would take the
 * default slug instead, which is how this test once read a found runtime.
 */
function runtimeTx(slug: string | null = CEDAR_RUNTIME) {
  const findFirst = vi.fn(async () => (slug === null ? undefined : { slug }));
  return {
    tx: { query: { runtimes: { findFirst } } } as unknown as Parameters<
      typeof resolveHostCedar
    >[0],
    findFirst,
  };
}

/** A reader with Cedar's evaluator loaded, counting the loads. */
function reader(port: TachoPublished) {
  const loads = { count: 0 };
  const read = createHostCedarReader(port, {
    cedar: async () => {
      loads.count += 1;
      return runtime;
    },
  });
  return { read, loads };
}

/** The workspace's compiled set, read for the default host. */
async function compiled(
  port: TachoPublished = cedarPort(),
): Promise<CompiledPolicySet> {
  const policy = await reader(port).read.read("get_tacho_bundle", CTX, hostRow());
  if (policy === undefined) throw new Error("The fixture did not compile.");
  return policy;
}

/** The unsigned bundle a host gets from what `port` serves. */
async function hostBundle(
  port: TachoPublished,
  host: TachoHostRow = hostRow(),
  read = reader(port).read,
) {
  const policy = await read.read("get_tacho_bundle", CTX, host);
  const cedar = await resolveHostCedar(runtimeTx().tx, host, policy);
  return unsignedBundle(
    host,
    DENY_GENERATION,
    RETENTION,
    STEERING,
    { ...NO_MANDATE, ...cedar },
    NOW,
  );
}

/** The same host's bundle with no Cedar part at all. */
function bundleWithoutCedar(host: TachoHostRow = hostRow()) {
  return unsignedBundle(
    host,
    DENY_GENERATION,
    RETENTION,
    STEERING,
    NO_MANDATE,
    NOW,
  );
}

/** What the host's hook decides for one shell call from a signed, verified bundle. */
function decideShell(
  bundle: ReturnType<typeof policyBundleSchema.parse>,
  harness: "claude-code" | "codex",
) {
  return evaluatePreToolUse({
    bundle,
    bundleVerified: true,
    toolName: harness === "claude-code" ? "Bash" : "shell",
    toolInput:
      harness === "claude-code"
        ? { command: "ls" }
        : { command: ["bash", "-lc", "ls"] },
    hostStatus: bundle.host_status,
    controlReachable: true,
    now: NOW.getTime(),
    cedar: { runtime, harness },
  });
}

describe("hostCedarReader", () => {
  it("reads nothing published for a host that did not advertise Cedar", async () => {
    const port = cedarPort();
    port.published = async () => {
      throw new Error("a host that did not ask should not cost a read");
    };
    const { read, loads } = reader(port);
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow({ bundleFeatures: [] })),
    ).resolves.toBeUndefined();
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow({ bundleFeatures: null })),
    ).resolves.toBeUndefined();
    expect(loads.count).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers nothing for a workspace with no steering repo or no published version", async () => {
    const { read, loads } = reader(NOTHING_PUBLISHED);
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).resolves.toBeUndefined();
    const { read: none } = reader(cedarPort(null));
    await expect(
      none.read("get_tacho_bundle", CTX, hostRow()),
    ).resolves.toBeUndefined();
    expect(loads.count).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers nothing for an organization repo's version, which names no workspace", async () => {
    const { read } = reader(cedarPort(cedarVersion({ organization: true })));
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).resolves.toBeUndefined();
  });

  it("compiles the published policies and every agent, as the gateway does", async () => {
    const policy = await compiled();
    expect(Object.keys(policy.policies)).toContain(NO_SHELL_ID);
    expect(Object.keys(policy.policies)).toContain("grant.builtin.claude-code");
    expect(policy.principals.map((agent) => agent.name).sort()).toEqual(
      [CI_BOT, RELEASE_BOT, REVIEWER].sort(),
    );
    expect(policy.cedar_version).toBe(runtime.getCedarVersion());
  });

  it("compiles a published version once and keeps it", async () => {
    const port = cedarPort();
    const { read, loads } = reader(port);
    const first = await read.read("get_tacho_bundle", CTX, hostRow());
    const second = await read.read("fetch_commands", CTX, hostRow());
    expect(second).toBe(first);
    expect(loads.count).toBe(1);
    expect(port.reads).toBe(2);
  });

  it("compiles a newly published version on the next read", async () => {
    const port = cedarPort();
    const { read } = reader(port);
    const first = await read.read("get_tacho_bundle", CTX, hostRow());
    port.version = cedarVersion({ version: 2 });
    const second = await read.read("get_tacho_bundle", CTX, hostRow());
    expect(Object.keys(first?.policies ?? {})).not.toContain(
      REVIEWER_NO_SHELL_ID,
    );
    expect(Object.keys(second?.policies ?? {})).toContain(REVIEWER_NO_SHELL_ID);
  });

  it("logs a version that does not compile once, and answers nothing", async () => {
    const port = cedarPort(cedarVersion({ policies: [BROKEN_POLICY] }));
    const { read, loads } = reader(port);
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/do not compile/);
    // The version never changes, so its failure is kept and not logged again.
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(loads.count).toBe(1);
  });

  it("logs a tool manifest that does not parse, and answers nothing", async () => {
    const version = cedarVersion();
    const port = cedarPort({
      ...version,
      tools: { schema: "tool-manifest/v1", servers: "not a list" },
    } as unknown as typeof version);
    const { read } = reader(port);
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).resolves.toBeUndefined();
    expect(warn.mock.calls[0]?.[1]).toMatch(/tool manifest does not parse/);
  });

  it("tries again on the next read when the evaluator did not load", async () => {
    let loaded: CedarRuntime | null = null;
    const read = createHostCedarReader(cedarPort(), {
      cedar: async () => loaded,
    });
    // Nothing has compiled yet, so no earlier set can stand in. Answering no
    // policies would sign a bundle that allows what they forbid (#5381).
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).rejects.toThrow(CedarPoliciesUnavailableError);
    expect(warn.mock.calls[0]?.[1]).toMatch(/evaluator did not load/);
    loaded = runtime;
    const policy = await read.read("get_tacho_bundle", CTX, hostRow());
    expect(policy?.policies).toHaveProperty(NO_SHELL_ID);
  });

  it("serves the last set that compiled when the evaluator did not load for a new version", async () => {
    const port = cedarPort();
    let loaded: CedarRuntime | null = runtime;
    const read = createHostCedarReader(port, { cedar: async () => loaded });
    const first = await read.read("get_tacho_bundle", CTX, hostRow());
    expect(first?.policies).toHaveProperty(NO_SHELL_ID);
    // A version already compiled never asks for the evaluator, so only a
    // newly published one meets the missing evaluator.
    port.version = cedarVersion({ version: 2 });
    loaded = null;
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).resolves.toBe(first);
    expect(warn.mock.calls.at(-1)?.[1]).toMatch(
      /evaluator did not load, so the host receives the last policies that compiled/,
    );
    // The evaluator loads on a later poll, and the new version compiles.
    loaded = runtime;
    const next = await read.read("get_tacho_bundle", CTX, hostRow());
    expect(next?.policies).toHaveProperty(REVIEWER_NO_SHELL_ID);
  });

  it("fails the read, and logs it, when the published version cannot be read and nothing has compiled", async () => {
    const port = cedarPort();
    port.published = async () => {
      throw new Error("the version store is down");
    };
    const { read } = reader(port);
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).rejects.toThrow(CedarPoliciesUnavailableError);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      err: "the version store is down",
    });
  });

  it("serves the last set that compiled, and keeps the etag, when the published version cannot be read", async () => {
    const port = cedarPort();
    const { read } = reader(port);
    const first = await read.read("get_tacho_bundle", CTX, hostRow());
    const served = await hostBundle(port, hostRow(), read);
    expect(served.etag).not.toBe(bundleWithoutCedar().etag);
    // A GitHub outage on a legacy steering connection fails the read the
    // same way.
    port.published = async () => {
      throw new Error("the version store is down");
    };
    await expect(
      read.read("fetch_commands", CTX, hostRow()),
    ).resolves.toBe(first);
    // The host's next poll names the etag it holds, so it keeps its policies.
    expect((await hostBundle(port, hostRow(), read)).etag).toBe(served.etag);
  });

  it("serves nothing it held once a read finds nothing published, even when a later read fails", async () => {
    const port = cedarPort();
    const { read } = reader(port);
    await read.read("get_tacho_bundle", CTX, hostRow());
    // The workspace's steering repo is unlinked. A read that worked says the
    // workspace has no policies, so an outage must not bring them back.
    port.version = null;
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).resolves.toBeUndefined();
    port.published = async () => {
      throw new Error("the version store is down");
    };
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).rejects.toThrow(CedarPoliciesUnavailableError);
  });

  it("serves the newest set that compiled, not the first, when a later read fails", async () => {
    const port = cedarPort();
    const { read } = reader(port);
    const first = await read.read("get_tacho_bundle", CTX, hostRow());
    port.version = cedarVersion({ version: 2 });
    const second = await read.read("get_tacho_bundle", CTX, hostRow());
    expect(second).not.toBe(first);
    expect(second?.policies).toHaveProperty(REVIEWER_NO_SHELL_ID);
    port.published = async () => {
      throw new Error("the version store is down");
    };
    await expect(
      read.read("get_tacho_bundle", CTX, hostRow()),
    ).resolves.toBe(second);
  });

  it("never serves one workspace the set another workspace compiled (negative)", async () => {
    const port = cedarPort();
    const { read } = reader(port);
    await read.read("get_tacho_bundle", CTX, hostRow());
    port.published = async () => {
      throw new Error("the version store is down");
    };
    // Another workspace in the same organization, and the same workspace id
    // under another organization. This reader compiled nothing for either.
    const sibling: CapabilityContext = {
      ...CTX,
      workspaceId: "00000000-0000-4000-8000-000000000003",
    };
    const otherOrg: CapabilityContext = {
      ...CTX,
      orgId: "00000000-0000-4000-8000-000000000009",
    };
    await expect(
      read.read("get_tacho_bundle", sibling, hostRow()),
    ).rejects.toThrow(CedarPoliciesUnavailableError);
    await expect(
      read.read("get_tacho_bundle", otherOrg, hostRow()),
    ).rejects.toThrow(CedarPoliciesUnavailableError);
  });

  it("shares one reader between the routes bound to one port", () => {
    const port = cedarPort();
    expect(hostCedarReader(port)).toBe(hostCedarReader(port));
    expect(hostCedarReader(port)).not.toBe(hostCedarReader(cedarPort()));
  });
});

describe("readCedarForEnvelope", () => {
  it("answers no policies for the typed error, logs it, and lets any other error through", async () => {
    const port = cedarPort();
    port.published = async () => {
      throw new Error("the version store is down");
    };
    const { read } = reader(port);
    await expect(
      readCedarForEnvelope(read, "fetch_commands", CTX, hostRow()),
    ).resolves.toBeUndefined();
    expect(warn.mock.calls.at(-1)?.[1]).toMatch(/etag leaves Cedar out/);
    const broken = {
      read: async () => {
        throw new Error("a defect in the reader");
      },
    };
    await expect(
      readCedarForEnvelope(broken, "fetch_commands", CTX, hostRow()),
    ).rejects.toThrow("a defect in the reader");
  });
});

describe("resolveHostCedar", () => {
  it("keeps only the agents on the host's runtime", async () => {
    const policy = await compiled();
    const { tx, findFirst } = runtimeTx();
    const { cedar } = await resolveHostCedar(tx, hostRow(), policy);
    expect(cedar?.principals.map((agent) => agent.name).sort()).toEqual(
      [RELEASE_BOT, REVIEWER].sort(),
    );
    expect(cedar?.policies).toEqual(policy.policies);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("reads no runtime for a host that did not advertise Cedar, binds no runtime, or has no set", async () => {
    const policy = await compiled();
    const { tx, findFirst } = runtimeTx();
    await expect(
      resolveHostCedar(tx, hostRow({ bundleFeatures: [] }), policy),
    ).resolves.toEqual({});
    await expect(
      resolveHostCedar(tx, hostRow({ runtimeId: null }), policy),
    ).resolves.toEqual({});
    await expect(resolveHostCedar(tx, hostRow(), undefined)).resolves.toEqual(
      {},
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("gives no Cedar to a host whose runtime no agent runs on, or whose runtime is not found", async () => {
    const policy = await compiled();
    await expect(
      resolveHostCedar(runtimeTx("mac-mini-2").tx, hostRow(), policy),
    ).resolves.toEqual({});
    await expect(
      resolveHostCedar(runtimeTx(null).tx, hostRow(), policy),
    ).resolves.toEqual({});
  });

  it("leaves out a part the host's schema refuses, and logs it", async () => {
    const policy = await compiled();
    const [agent] = policy.principals.filter(
      (held) => held.runtime === CEDAR_RUNTIME,
    );
    if (agent === undefined) throw new Error("The fixture runs no agent here.");
    // The host's schema allows 64 agents on one runtime.
    const crowded = {
      ...policy,
      principals: Array.from({ length: 65 }, (_, i) => ({
        ...agent,
        name: `acme.core.bot-${i}`,
      })),
    };
    await expect(
      resolveHostCedar(runtimeTx().tx, hostRow(), crowded),
    ).resolves.toEqual({});
    expect(warn.mock.calls[0]?.[1]).toMatch(/do not fit the bundle's schema/);
  });
});

describe("the Cedar part of the signed bundle", () => {
  it("signs a bundle from a published version, verifies it on the host, and denies builtin__shell for the agent a policy names", async () => {
    const signer = bundleSignerFromPem(PEM);
    const signed = signBundle(signer, await hostBundle(cedarPort()));
    // The host's own strict schema, so a field it cannot parse would fail here.
    const onHost = policyBundleSchema.parse(signed);
    expect(verifyOnHost(onHost, signer.publicKeyPem, HOST_PUBLIC)).toEqual({
      ok: true,
    });
    expect(onHost.cedar?.principals.map((agent) => agent.name).sort()).toEqual(
      [RELEASE_BOT, REVIEWER].sort(),
    );

    // Claude Code's Bash is builtin__shell, and the policy forbids it the
    // release bot, the Claude Code agent on this runtime.
    expect(decideShell(onHost, "claude-code")).toMatchObject({
      decision: "deny",
      reason_code: "cedar_deny",
      rule: NO_SHELL_ID,
    });
    // Codex's shell is builtin__shell too, and the reviewer may run it, so the
    // harness's own permission flow decides.
    expect(decideShell(onHost, "codex")).toMatchObject({
      decision: "ask",
      reason_code: "cedar_allow",
    });
  });

  it("refuses a bundle whose Cedar part was changed after signing", async () => {
    const signer = bundleSignerFromPem(PEM);
    const signed = signBundle(signer, await hostBundle(cedarPort()));
    const tampered = policyBundleSchema.parse({
      ...signed,
      cedar: {
        ...signed.cedar,
        policies: {
          ...signed.cedar?.policies,
          [NO_SHELL_ID]: "permit (principal, action, resource);",
        },
      },
    });
    expect(verifyOnHost(tampered, signer.publicKeyPem, HOST_PUBLIC).ok).toBe(
      false,
    );
  });

  it("gives a workspace with no steering repo or no published version a bundle without Cedar", async () => {
    const baseline = bundleWithoutCedar();
    for (const port of [NOTHING_PUBLISHED, cedarPort(null)]) {
      const bundle = await hostBundle(port);
      expect(bundle).not.toHaveProperty("cedar");
      expect(bundle.etag).toBe(baseline.etag);
      expect(() =>
        policyBundleSchema.parse(signBundle(bundleSignerFromPem(PEM), bundle)),
      ).not.toThrow();
    }
  });

  it("serves the bundle without Cedar when the published version does not compile", async () => {
    const bundle = await hostBundle(
      cedarPort(cedarVersion({ policies: [BROKEN_POLICY] })),
    );
    expect(bundle).not.toHaveProperty("cedar");
    expect(bundle.etag).toBe(bundleWithoutCedar().etag);
    expect(warn).toHaveBeenCalled();
  });

  it("sends no Cedar to a host that did not advertise it, and keeps its etag", async () => {
    const host = hostRow({ bundleFeatures: [] });
    const bundle = await hostBundle(cedarPort(), host);
    expect(bundle).not.toHaveProperty("cedar");
    expect(bundle.etag).toBe(bundleWithoutCedar(host).etag);
  });

  it("moves the etag when a newly published version changes the policies, and only then", async () => {
    const port = cedarPort();
    const read = reader(port).read;
    const first = await hostBundle(port, hostRow(), read);
    // The same version read again keeps its etag, so a poll answers not_modified.
    expect((await hostBundle(port, hostRow(), read)).etag).toBe(first.etag);
    expect(first.etag).not.toBe(bundleWithoutCedar().etag);

    port.version = cedarVersion({ version: 2 });
    const next = await hostBundle(port, hostRow(), read);
    expect(next.etag).not.toBe(first.etag);

    // The host that fetches the new bundle decides with the new policies.
    const signer = bundleSignerFromPem(PEM);
    const onHost = policyBundleSchema.parse(signBundle(signer, next));
    expect(verifyOnHost(onHost, signer.publicKeyPem, HOST_PUBLIC).ok).toBe(
      true,
    );
    expect(decideShell(onHost, "codex")).toMatchObject({
      decision: "deny",
      reason_code: "cedar_deny",
      rule: REVIEWER_NO_SHELL_ID,
    });
  });
});
