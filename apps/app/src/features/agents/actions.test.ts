// The agent writes through the real kernel seam: the viewer resolution and the
// kernel's invoke() are the only fakes, so each case shows what the person gets
// back and whether the capability ran — ok, invalid (refused before the kernel)
// and denied for every action (INV-19). request_mandate converts the amounts a
// person typed into micros and refuses a figure that is not a plain decimal
// before anything reaches the kernel.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MANDATE_ID, mandateOutput } from "@/test/mandate-outputs";

const { invoke, requireViewer, kernelRead } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
  kernelRead: vi.fn(),
}));
import { costCenterList } from "@oxagen/oxagen/contracts/cost_center.list";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";

vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
// registerAgent drafts the wizard's file with the catalog's comment lines.
vi.mock("next-intl/server", async () => {
  const { translator } = await import("@/test/intl");
  return {
    getTranslations: (namespace: string) =>
      Promise.resolve(translator(namespace)),
  };
});
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));
// The writes run through the real seam; the one read a mandate request makes —
// the person's saved zone — is faked here, so `invoke` answers writes alone.
vi.mock("@/server/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/kernel")>()),
  kernelRead,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  assignAgentRole,
  commitAgentDefinition,
  issueAgentEnrollmentToken,
  pauseAgent,
  readAssignableRoles,
  readCostCenters,
  registerAgent,
  setAgentCostCenter,
  requestMandate,
  retireAgent,
  revokeAgentRole,
  revokeHostEnrollment,
  rotateAgentCredential,
  setAgentSuspended,
} = await import("./actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const AT = "2026-09-15T09:00:00.000Z";
/** The CapabilityContext every write reaches the kernel with. */
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};
const denied = (name: string) =>
  new kernel.CapabilityError(name, "authz_denied", "denied");

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
  kernelRead.mockReset();
  kernelRead.mockResolvedValue({ ok: true, value: { timezone: "UTC" } });
});

describe("rotateAgentCredential", () => {
  it("rotates for the workspace viewer and returns the new secret once", async () => {
    invoke.mockResolvedValue({
      agentId: "agt_releasebot",
      revokedCredentialId: "aky_1",
      credential: { id: "aky_2", secret: "oxa_ag_s3cr3t", expiresAt: AT },
    });
    expect(
      await rotateAgentCredential("acme", "core-platform", "agt_releasebot"),
    ).toEqual({ ok: true, value: { secret: "oxa_ag_s3cr3t", expiresAt: AT } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "rotate_agent_credential",
      { agentId: "agt_releasebot" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty agent before the kernel runs (negative)", async () => {
    expect(await rotateAgentCredential("acme", "core-platform", "")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "agentId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("rotate_agent_credential"));
    expect(
      await rotateAgentCredential("acme", "core-platform", "agt_releasebot"),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

const HOST = "tch_0123456789abcdefghijkl";
const TOKEN = "oxe_1time_23456789abcdefghjkmnpqrstv";

describe("revokeHostEnrollment", () => {
  it("revokes the host for the workspace viewer and answers the recorded instant", async () => {
    invoke.mockResolvedValue({
      hostEnrollmentId: HOST,
      status: "revoked",
      revokedAt: AT,
    });
    expect(
      await revokeHostEnrollment(
        "acme",
        "core-platform",
        HOST,
        "  laptop returned  ",
      ),
    ).toEqual({ ok: true, value: { revokedAt: AT } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "revoke_tacho_enrollment",
      { hostEnrollmentId: HOST, reason: "laptop returned" },
      expect.objectContaining(TENANT),
    );
  });

  it("sends no reason at all when the box is blank", async () => {
    // The contract's input is strict with `reason` optional, and an empty
    // string is a recorded reason that says nothing.
    invoke.mockResolvedValue({
      hostEnrollmentId: HOST,
      status: "revoked",
      revokedAt: AT,
    });
    await revokeHostEnrollment("acme", "core-platform", HOST, "   ");
    expect(invoke).toHaveBeenCalledWith(
      "revoke_tacho_enrollment",
      { hostEnrollmentId: HOST },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an id that is not a host enrollment public id before the kernel runs (negative)", async () => {
    expect(
      await revokeHostEnrollment("acme", "core-platform", "agt_releasebot", ""),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "hostEnrollmentId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a reason longer than the contract allows (negative)", async () => {
    expect(
      await revokeHostEnrollment(
        "acme",
        "core-platform",
        HOST,
        "x".repeat(513),
      ),
    ).toMatchObject({ ok: false, reason: "invalid", field: "reason" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("revoke_tacho_enrollment"));
    expect(
      await revokeHostEnrollment("acme", "core-platform", HOST, ""),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("issueAgentEnrollmentToken", () => {
  it("mints for the named agent and answers the token, its expiry and the command", async () => {
    invoke.mockResolvedValue({
      tokenId: "tet_9",
      token: TOKEN,
      expiresAt: AT,
      agentId: "agt_releasebot",
      agentKey: "acme.core.release-bot",
      enrollCommand: `oxagen agent enroll --token ${TOKEN}`,
    });
    expect(
      await issueAgentEnrollmentToken(
        "acme",
        "core-platform",
        "agt_releasebot",
      ),
    ).toEqual({
      ok: true,
      value: {
        token: TOKEN,
        expiresAt: AT,
        enrollCommand: `oxagen agent enroll --token ${TOKEN}`,
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "create_enrollment_token",
      { agentId: "agt_releasebot" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty agent before the kernel runs (negative)", async () => {
    expect(
      await issueAgentEnrollmentToken("acme", "core-platform", ""),
    ).toMatchObject({ ok: false, reason: "invalid", field: "agentId" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("create_enrollment_token"));
    expect(
      await issueAgentEnrollmentToken(
        "acme",
        "core-platform",
        "agt_releasebot",
      ),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("setAgentSuspended", () => {
  it("suspends, and resumes with suspended false", async () => {
    invoke.mockResolvedValueOnce({
      agentId: "agt_releasebot",
      status: "suspended",
      changedAt: AT,
    });
    expect(
      await setAgentSuspended("acme", "core-platform", "agt_releasebot", true),
    ).toEqual({ ok: true, value: { status: "suspended" } });
    invoke.mockResolvedValueOnce({
      agentId: "agt_releasebot",
      status: "active",
      changedAt: AT,
    });
    expect(
      await setAgentSuspended("acme", "core-platform", "agt_releasebot", false),
    ).toEqual({ ok: true, value: { status: "active" } });
    expect(invoke.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["suspend_agent", { agentId: "agt_releasebot", suspended: true }],
      ["suspend_agent", { agentId: "agt_releasebot", suspended: false }],
    ]);
  });

  it("refuses an agent id longer than the contract allows (negative)", async () => {
    expect(
      await setAgentSuspended("acme", "core-platform", "a".repeat(129), true),
    ).toMatchObject({ ok: false, reason: "invalid", field: "agentId" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("suspend_agent"));
    expect(
      await setAgentSuspended("acme", "core-platform", "agt_releasebot", true),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("retireAgent", () => {
  it("retires the agent and returns when", async () => {
    invoke.mockResolvedValue({
      agentId: "agt_releasebot",
      status: "retired",
      revokedCredentials: 1,
      revokedHosts: 2,
      revokedMandates: 0,
      retiredAt: AT,
    });
    expect(
      await retireAgent("acme", "core-platform", "agt_releasebot"),
    ).toEqual({ ok: true, value: { retiredAt: AT } });
    expect(invoke).toHaveBeenCalledWith(
      "retire_agent",
      { agentId: "agt_releasebot" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty agent before the kernel runs (negative)", async () => {
    expect(await retireAgent("acme", "core-platform", "")).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "agentId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("retire_agent"));
    expect(
      await retireAgent("acme", "core-platform", "agt_releasebot"),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("pauseAgent", () => {
  const agent = {
    agentId: "agt_releasebot",
    agentKey: "acme.core.release-bot",
  };
  const DENY_GENERATION = { org: 4, workspace: 9 };

  it("flips the switch, then broadcasts a pause to the agent's live runs", async () => {
    invoke
      .mockResolvedValueOnce({
        switchId: "emd_1",
        on: true,
        changed: true,
        denyGeneration: DENY_GENERATION,
        grantsRevoked: 0,
      })
      .mockResolvedValueOnce({ commandIds: ["tcm_1", "tcm_2"] });
    expect(
      await pauseAgent("acme", "core-platform", agent, "Credential leaked"),
    ).toEqual({
      ok: true,
      value: {
        switchId: "emd_1",
        changed: true,
        denyGeneration: DENY_GENERATION,
        pause: { kind: "paused", commandIds: ["tcm_1", "tcm_2"] },
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "set_kill_switch",
      {
        target: { kind: "agent", id: "agt_releasebot" },
        on: true,
        reason: "Credential leaked",
      },
      expect.objectContaining(TENANT),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "dispatch_command",
      {
        target: { kind: "agent", id: "acme.core.release-bot" },
        command: "pause",
        reason: "Credential leaked",
      },
      expect.objectContaining(TENANT),
    );
  });

  it("reports no live run to pause rather than a paused count of zero", async () => {
    invoke
      .mockResolvedValueOnce({
        switchId: "emd_1",
        on: true,
        changed: true,
        denyGeneration: DENY_GENERATION,
        grantsRevoked: 0,
      })
      .mockResolvedValueOnce({ commandIds: [] });
    const result = await pauseAgent("acme", "core-platform", agent, "Testing");
    expect(result).toMatchObject({
      ok: true,
      value: { pause: { kind: "no_live_runs" } },
    });
  });

  it("refuses an empty reason before the kernel runs, and never dispatches a pause (negative)", async () => {
    expect(await pauseAgent("acme", "core-platform", agent, "")).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "reason",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stops at the switch refusal and never attempts the broadcast (negative)", async () => {
    invoke.mockRejectedValueOnce(denied("set_kill_switch"));
    expect(
      await pauseAgent("acme", "core-platform", agent, "Testing"),
    ).toMatchObject({ ok: false, reason: "denied" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("skips the broadcast for an agent with no key, without calling dispatch_command (negative)", async () => {
    invoke.mockResolvedValueOnce({
      switchId: "emd_2",
      on: true,
      changed: true,
      denyGeneration: DENY_GENERATION,
      grantsRevoked: 0,
    });
    const result = await pauseAgent(
      "acme",
      "core-platform",
      { agentId: "agt_releasebot", agentKey: null },
      "Testing",
    );
    expect(result).toMatchObject({
      ok: true,
      value: { pause: { kind: "no_agent_key" } },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps the switch's effect when the broadcast itself is refused, and names the refusal (negative)", async () => {
    invoke
      .mockResolvedValueOnce({
        switchId: "emd_3",
        on: true,
        changed: true,
        denyGeneration: DENY_GENERATION,
        grantsRevoked: 0,
      })
      .mockRejectedValueOnce(denied("dispatch_command"));
    const result = await pauseAgent("acme", "core-platform", agent, "Testing");
    expect(result).toMatchObject({
      ok: true,
      value: {
        switchId: "emd_3",
        pause: { kind: "failed", failure: { ok: false, reason: "denied" } },
      },
    });
  });
});

describe("commitAgentDefinition", () => {
  const draft = {
    agentId: "agt_releasebot",
    branch: " agents/release-bot ",
    message: " Light tier ",
    source: 'slug = "release-bot"\n',
  };

  it("commits the trimmed branch and message with the file as written, and returns the pull request", async () => {
    invoke.mockResolvedValue({
      agentId: "agt_releasebot",
      version: 2,
      path: ".oxagen/agents/release-bot.toml",
      digest: "b".repeat(64),
      commitSha: "4d5e6f7",
      branch: "agents/release-bot",
      pullRequest: { number: 12, url: "https://github.com/acme/core/pull/12" },
    });
    expect(await commitAgentDefinition("acme", "core-platform", draft)).toEqual(
      {
        ok: true,
        value: {
          branch: "agents/release-bot",
          commitSha: "4d5e6f7",
          pullRequest: {
            number: 12,
            url: "https://github.com/acme/core/pull/12",
          },
        },
      },
    );
    expect(invoke).toHaveBeenCalledWith(
      "commit_agent_definition",
      {
        agentId: "agt_releasebot",
        branch: "agents/release-bot",
        message: "Light tier",
        source: 'slug = "release-bot"\n',
      },
      expect.objectContaining(TENANT),
    );
  });

  it("leaves a blank message to the handler", async () => {
    invoke.mockRejectedValue(denied("commit_agent_definition"));
    await commitAgentDefinition("acme", "core-platform", {
      ...draft,
      message: "   ",
    });
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      agentId: "agt_releasebot",
      branch: "agents/release-bot",
      source: 'slug = "release-bot"\n',
    });
  });

  it.each([
    ["a qualified ref", { branch: "refs/heads/main" }, "branch"],
    ["an empty file", { source: "" }, "source"],
  ])(
    "refuses %s before the kernel runs (negative)",
    async (_what, change, field) => {
      expect(
        await commitAgentDefinition("acme", "core-platform", {
          ...draft,
          ...change,
        }),
      ).toEqual({ ok: false, reason: "invalid", code: "invalid_input", field });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("commit_agent_definition"));
    expect(
      await commitAgentDefinition("acme", "core-platform", draft),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("registerAgent", () => {
  const OPENED = {
    slug: "perf-watch",
    agentKey: "acme.core.perf-watch",
    path: ".oxagen/agents/perf-watch.toml",
    generatedPath: ".claude/agents/perf-watch.md",
    branch: "agents/perf-watch",
    repository: "acme/platform",
    baseRef: "main",
    digest: `sha256:${"a".repeat(64)}`,
    checks: [],
    commitSha: "c0ffee",
    pullRequest: {
      number: 526,
      url: "https://github.com/acme/platform/pull/526",
    },
  };
  const draft = { slug: " perf-watch ", harness: "cursor", tier: "light" };

  it("opens the Context PR with the wizard's file for the slug, harness and tier, and returns the pull request", async () => {
    invoke.mockResolvedValue(OPENED);
    expect(await registerAgent("acme", "core-platform", draft)).toEqual({
      ok: true,
      value: {
        path: ".oxagen/agents/perf-watch.toml",
        pullRequest: {
          number: 526,
          url: "https://github.com/acme/platform/pull/526",
        },
      },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    const [name, input, context] = invoke.mock.calls[0] ?? [];
    expect(name).toBe("propose_agent");
    expect(context).toEqual(expect.objectContaining(TENANT));
    expect(input).toMatchObject({ slug: "perf-watch", harness: "cursor" });
    const source =
      typeof input === "object" &&
      input !== null &&
      "source" in input &&
      typeof input.source === "string"
        ? input.source
        : "";
    expect(source).toContain('slug = "perf-watch"');
    expect(source).toContain('model_tier = "light"');
    expect(source).toContain("[harness.cursor]");
    expect(source).toContain("# .oxagen/agents/perf-watch.toml");
  });

  it.each([
    ["a slug with capitals", { slug: "Perf-Watch" }, "slug"],
    ["a slug over 18 characters", { slug: "a-very-long-agent-slug" }, "slug"],
    ["a harness off the list", { harness: "vim" }, "harness"],
    ["a tier off the list", { tier: "heavy" }, "tier"],
  ])(
    "refuses %s before the kernel runs (negative)",
    async (_what, change, field) => {
      expect(
        await registerAgent("acme", "core-platform", { ...draft, ...change }),
      ).toEqual({ ok: false, reason: "invalid", code: "invalid_input", field });
      expect(invoke).not.toHaveBeenCalled();
      expect(requireViewer).not.toHaveBeenCalled();
    },
  );

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("propose_agent"));
    expect(await registerAgent("acme", "core-platform", draft)).toMatchObject({
      ok: false,
      reason: "denied",
    });
  });
});

describe("a person the workspace refuses", () => {
  it.each([
    [
      "rotateAgentCredential",
      () => rotateAgentCredential("acme", "x", "agt_a"),
    ],
    ["setAgentSuspended", () => setAgentSuspended("acme", "x", "agt_a", true)],
    ["retireAgent", () => retireAgent("acme", "x", "agt_a")],
    [
      "registerAgent",
      () =>
        registerAgent("acme", "x", {
          slug: "perf-watch",
          harness: "cursor",
          tier: "light",
        }),
    ],
    [
      "commitAgentDefinition",
      () =>
        commitAgentDefinition("acme", "x", {
          agentId: "agt_a",
          branch: "b",
          message: "",
          source: "s",
        }),
    ],
  ])("%s runs nothing (negative)", async (_name, run) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("requestMandate", () => {
  const draft = {
    agentId: "agt_invoicebot",
    consequenceTags: "moves_money, alters_production",
    measure: "rows",
    unit: "rows",
    perCall: "50",
    perPeriod: "1000",
    period: "monthly" as const,
    callsPerDay: "50",
    tools: "stripe__create_payment@*, aws_billing__purchase_savings_plan@2",
    purpose: "  monthly infrastructure invoices, PO-4471  ",
    validFrom: "2026-09-01",
    validTo: "2026-12-31",
  };
  const good = { ...draft };

  it("asks for a draft with the limits as typed and the tools split", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    expect(await requestMandate("acme", "core-platform", good)).toEqual({
      ok: true,
      value: { mandateId: MANDATE_ID, status: "draft" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "request_mandate",
      {
        agentId: "agt_invoicebot",
        consequenceTags: ["moves_money", "alters_production"],
        limits: {
          rows: {
            perCall: "50",
            perPeriod: "1000",
            period: "monthly",
            currencyOrUnit: "rows",
          },
          calls: {
            perPeriod: "50",
            period: "daily",
            currencyOrUnit: "calls",
          },
        },
        targets: {},
        tools: [
          "stripe__create_payment@*",
          "aws_billing__purchase_savings_plan@2",
        ],
        approval: { humanAbove: {}, alwaysHumanFor: [], approvers: [] },
        purpose: "monthly infrastructure invoices, PO-4471",
        validFrom: "2026-09-01T00:00:00.000Z",
        validTo: "2026-12-31T23:59:59.999Z",
      },
      expect.objectContaining(TENANT),
    );
  });

  // The defect this closes, reached twice by two routes: a limit that leaves
  // this action larger than the operator typed. It was `microsFromDecimal`
  // scaling every limit, then `microsFromDecimal` scaling whichever the
  // operator called an amount — and a tool that declares the measure as a
  // count has the gate read 50000000 as fifty million of them. Nothing here
  // multiplies now, so there is no figure to get wrong.
  it.each([
    ["50", "50"],
    ["1", "1"],
    ["0", "0"],
    ["999999999999999999999999999999", "999999999999999999999999999999"],
  ])(
    "stores a per-call limit of %s as %s and never scales it",
    async (typed, stored) => {
      invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
      await requestMandate("acme", "core-platform", {
        ...good,
        perCall: typed,
        perPeriod: "",
        callsPerDay: "",
      });
      const sent = invoke.mock.calls[0]?.[1];
      expect(sent).toMatchObject({ limits: { rows: { perCall: stored } } });
      // The figure micros would have made of it, which must appear nowhere.
      expect(JSON.stringify(sent)).not.toContain(`${stored}000000`);
    },
  );

  it("names only the limits the person filled in", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", {
      ...good,
      perCall: "",
      callsPerDay: "",
    });
    expect(invoke.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        limits: {
          rows: {
            perPeriod: "1000",
            period: "monthly",
            currencyOrUnit: "rows",
          },
        },
      }),
    );
  });

  it.each([
    [{ measure: "  " }, "measure"],
    [{ consequenceTags: "" }, "consequenceTags"],
    [{ consequenceTags: " , , " }, "consequenceTags"],
    [{ perCall: "", perPeriod: "" }, "perPeriod"],
    [{ perCall: "1,250" }, "perCall"],
    [{ perPeriod: "-5" }, "perPeriod"],
    [{ callsPerDay: "many" }, "callsPerDay"],
    [{ callsPerDay: "-5" }, "callsPerDay"],
    [{ callsPerDay: "1.5" }, "callsPerDay"],
    [{ tools: " , " }, "tools"],
    [{ purpose: "   " }, "purpose"],
    [{ validFrom: "01/09/2026" }, "validFrom"],
    [{ validTo: "" }, "validTo"],
    [{ validFrom: "2026-12-31", validTo: "2026-09-01" }, "validTo"],
    // `calls` is the built-in measure: the gate reads one per call whatever a
    // limit says, so a limit filed under it would be read as a ceiling of that
    // many calls, and the grant handler exempts it from the measure-declared
    // check that would otherwise catch it.
    [{ measure: "calls" }, "measure"],
    [{ measure: "  calls  " }, "measure"],
    // A limit this form writes is whole units of the named unit, so a decimal
    // has no meaning in it and is refused rather than truncated.
    [{ perCall: "", perPeriod: "12.5" }, "perPeriod"],
    [{ perCall: "1.5", perPeriod: "" }, "perCall"],
    // A leading zero is refused rather than stripped: "007" is not a figure
    // the ledger's measure-value shape admits, and rewriting what was typed is
    // the habit this whole action is built to avoid.
    [{ perCall: "007", perPeriod: "" }, "perCall"],
    // A currency code would read back as money (`isCurrencyCode`) beside a
    // figure that is whole units, and money is the one limit this form cannot
    // write, because scaling it needs the tool's declaration. Both casings are
    // refused: an operator who meant money means it either way.
    [{ unit: "USD" }, "unit"],
    [{ unit: "usd" }, "unit"],
    [{ unit: "JPY" }, "unit"],
    [{ unit: "  " }, "unit"],
  ])("refuses %j before the kernel runs (negative)", async (patch, field) => {
    expect(
      await requestMandate("acme", "core-platform", { ...good, ...patch }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([["GAU"], ["RPM"], ["recipients"]])(
    "admits %s, a unit no currency set holds",
    async (unit) => {
      invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
      await requestMandate("acme", "core-platform", { ...good, unit });
      expect(invoke.mock.calls[0]?.[1]).toMatchObject({
        limits: { rows: { currencyOrUnit: unit } },
      });
    },
  );

  it("runs the authority through the end of the last day it names", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", good);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      validFrom: "2026-09-01T00:00:00.000Z",
      validTo: "2026-12-31T23:59:59.999Z",
    });
  });

  it("bounds the mandate days in the viewer's zone, not UTC", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: { timezone: "America/Los_Angeles" },
    });
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", {
      ...good,
      validFrom: "2026-01-15",
      validTo: "2026-01-15",
    });
    // PST (UTC-8): local midnight through 23:59:59.999.
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      validFrom: "2026-01-15T08:00:00.000Z",
      validTo: "2026-01-16T07:59:59.999Z",
    });
  });

  // Both of these fell back to Pacific. That is right for drawing a date and
  // wrong for writing a validity window: for an operator in Tokyo, Pacific moves
  // the end of their day 17 hours later, which is authority nobody granted, and
  // nothing afterwards says the zone was guessed. Refusing is visible, and the
  // grant can be made again once the zone is known.
  it("refuses the grant when the saved zone cannot be read (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "error",
      code: "control_plane_unavailable",
      status: 503,
    });
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    expect(
      await requestMandate("acme", "core-platform", {
        ...good,
        validFrom: "2026-01-15",
        validTo: "2026-01-15",
      }),
    ).toEqual({
      ok: false,
      reason: "unavailable",
      code: "time_zone_unavailable",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses the grant for a saved zone this runtime cannot format in (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: { timezone: "Mars/Olympus_Mons" },
    });
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    // A conflict rather than an unavailability: retrying will not help until the
    // person stores a zone this runtime knows.
    expect(
      await requestMandate("acme", "core-platform", {
        ...good,
        validFrom: "2026-01-15",
        validTo: "2026-01-15",
      }),
    ).toEqual({
      ok: false,
      reason: "conflict",
      code: "time_zone_unsupported",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts a mandate that starts and ends on one day", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    expect(
      await requestMandate("acme", "core-platform", {
        ...good,
        validFrom: "2026-09-01",
        validTo: "2026-09-01",
      }),
    ).toMatchObject({ ok: true });
  });

  it("keeps the named limit and the calls-per-day limit apart, both intact", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", good);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      limits: {
        rows: {
          perCall: "50",
          perPeriod: "1000",
          period: "monthly",
          currencyOrUnit: "rows",
        },
        calls: { perPeriod: "50", period: "daily", currencyOrUnit: "calls" },
      },
    });
  });

  // `findCoveringMandate` accepts a mandate only when it names EVERY tag the
  // tool declares, so a form that could send one tag minted mandates that were
  // granted exactly as asked and authorized nothing.
  it("sends every consequence named, de-duplicated and trimmed", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", {
      ...good,
      consequenceTags: " moves_money , alters_production ,moves_money, ",
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      consequenceTags: ["moves_money", "alters_production"],
    });
  });

  it("sends a single consequence as a set of one", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", {
      ...good,
      consequenceTags: "destroys_data",
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      consequenceTags: ["destroys_data"],
    });
  });

  // The six are a starter set the workspace extends, and `findCoveringMandate`
  // still wants every tag the tool declares — so a tool declaring a tag of the
  // workspace's own could otherwise never be given a mandate.
  it("sends a consequence tag the starter set does not hold", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", {
      ...good,
      consequenceTags: "ships_code, moves_money",
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      consequenceTags: ["ships_code", "moves_money"],
    });
  });

  it.each([["Ships_Code"], ["ships code"], ["s"], ["9lives"], ["ships-code"]])(
    "refuses %s, which is not a consequence tag (negative)",
    async (tag) => {
      expect(
        await requestMandate("acme", "core-platform", {
          ...good,
          consequenceTags: tag,
        }),
      ).toMatchObject({ ok: false, field: "consequenceTags" });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("refuses more tags than the mandate shape admits (negative)", async () => {
    expect(
      await requestMandate("acme", "core-platform", {
        ...good,
        consequenceTags: Array.from(
          { length: 17 },
          (_, i) => `tag_${String(i)}`,
        ).join(","),
      }),
    ).toMatchObject({ ok: false, field: "consequenceTags" });
    expect(invoke).not.toHaveBeenCalled();
  });

  // `calls` is a limit in its own right, and the only one a tool that carries
  // a consequence and declares no numeric measure can be given: the contract
  // takes it alone and `assertToolsDeclareMeasures` exempts it from the
  // declared-measure check. Requiring a measure limit as well shut that tool
  // out — blank fields refused here, an invented measure refused there.
  it("writes a calls-only mandate when no measure is named", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    expect(
      await requestMandate("acme", "core-platform", {
        ...good,
        measure: "",
        unit: "",
        perCall: "",
        perPeriod: "",
        callsPerDay: "500",
      }),
    ).toMatchObject({ ok: true });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      limits: {
        calls: { perPeriod: "500", period: "daily", currencyOrUnit: "calls" },
      },
    });
    // The measure entry is absent, not blank: no key but `calls`.
    expect(invoke.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        limits: {
          calls: { perPeriod: "500", period: "daily", currencyOrUnit: "calls" },
        },
      }),
    );
  });

  it.each([
    // Half a measure entry is refused rather than half-written: the four
    // fields stand or fall together.
    [{ measure: "rows", unit: "", perCall: "", perPeriod: "" }, "unit"],
    [{ measure: "", unit: "rows", perCall: "", perPeriod: "" }, "measure"],
    [{ measure: "", unit: "", perCall: "50", perPeriod: "" }, "measure"],
  ])(
    "refuses %j, a measure entry only partly filled (negative)",
    async (patch, field) => {
      expect(
        await requestMandate("acme", "core-platform", {
          ...good,
          ...patch,
          callsPerDay: "500",
        }),
      ).toMatchObject({ ok: false, field });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("refuses a mandate that names no limit at all (negative)", async () => {
    expect(
      await requestMandate("acme", "core-platform", {
        ...good,
        measure: "",
        unit: "",
        perCall: "",
        perPeriod: "",
        callsPerDay: "",
      }),
    ).toMatchObject({ ok: false, field: "perPeriod" });
    expect(invoke).not.toHaveBeenCalled();
  });

  // `calls` is a measure limit like any other, so `measureValueSchema` governs
  // its figure: thirty digits, not nine. The old nine-digit rule refused a cap
  // the ledger would have held.
  it.each([["1000000000"], ["9".repeat(30)]])(
    "accepts a calls cap of %s, past what nine digits hold",
    async (cap) => {
      invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
      expect(
        await requestMandate("acme", "core-platform", {
          ...good,
          callsPerDay: cap,
        }),
      ).toMatchObject({ ok: true });
      expect(invoke.mock.calls[0]?.[1]).toMatchObject({
        limits: { calls: { perPeriod: cap } },
      });
    },
  );

  it("refuses a calls cap past what the ledger's figure holds (negative)", async () => {
    expect(
      await requestMandate("acme", "core-platform", {
        ...good,
        callsPerDay: "9".repeat(31),
      }),
    ).toMatchObject({ ok: false, field: "callsPerDay" });
    expect(invoke).not.toHaveBeenCalled();
  });

  // The longest legal consequence set: sixteen tags at sixty-four characters.
  // A field that could not hold it truncated in the browser, and the truncated
  // set was still valid — requested, granted, covering nothing.
  it("accepts every consequence tag at its ceiling", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    // 62 + 2 = 64, the ceiling, and distinct for 00 through 15.
    const tags = Array.from(
      { length: 16 },
      (_, i) => `${"a".repeat(62)}${String(i).padStart(2, "0")}`,
    );
    expect(new Set(tags).size).toBe(16);
    expect(tags.every((tag) => tag.length === 64)).toBe(true);
    expect(
      await requestMandate("acme", "core-platform", {
        ...good,
        consequenceTags: tags.join(", "),
      }),
    ).toMatchObject({ ok: true });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      consequenceTags: tags,
    });
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("request_mandate"));
    expect(await requestMandate("acme", "core-platform", good)).toMatchObject({
      ok: false,
      reason: "denied",
    });
  });
});

/** One row of `list_iam_roles`, with the fields the offer reads. */
const roleRow = (
  name: string,
  over: Partial<{
    kind: "human" | "agent";
    scopeKind: "org" | "workspace";
    isSystemDefault: boolean;
  }> = {},
) => ({
  id: `rol_${name.toLowerCase().replaceAll(" ", "_")}`,
  name,
  description: null,
  scopeKind: "org" as const,
  kind: "agent" as const,
  isSystemDefault: false,
  version: "1",
  memberCount: 0,
  createdBy: null,
  permissions: [],
  ...over,
});

const catalogue = (
  roles: ReturnType<typeof roleRow>[],
  over: Partial<{ hasMore: boolean; enforced: boolean; tier: string }> = {},
) => ({
  ok: true,
  value: {
    roles,
    total: roles.length,
    hasMore: over.hasMore ?? false,
    limit: 200,
    offset: 0,
    catalog: [],
    enforcement: {
      tier: over.tier ?? "enterprise",
      enforced: over.enforced ?? true,
    },
  },
});

describe("readAssignableRoles", () => {
  it("offers the roles an agent may hold and drops the human ones", async () => {
    kernelRead.mockResolvedValue(
      catalogue([
        roleRow("Agent Contributor", { isSystemDefault: true }),
        roleRow("Release deputy", { scopeKind: "workspace" }),
        roleRow("Owner", { kind: "human", isSystemDefault: true }),
      ]),
    );
    expect(await readAssignableRoles("acme", "core-platform")).toEqual({
      ok: true,
      value: {
        roles: [
          { name: "Agent Contributor", scope: "org", builtIn: true },
          { name: "Release deputy", scope: "workspace", builtIn: false },
        ],
        enforced: true,
        tier: "enterprise",
        more: false,
      },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    // The contract is compared by identity, not by name: this is the same
    // module object the action imports, so a read that reached a different
    // contract fails here rather than passing on a matching name.
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: iamRoleList,
      input: { includeGrants: false, limit: 200, offset: 0 },
      page: "agents",
    });
  });

  // The picker says so rather than presenting a page as the catalogue.
  it("carries the tier that does not enforce, and a page that is not the whole catalogue", async () => {
    kernelRead.mockResolvedValue(
      catalogue([roleRow("Agent Observer", { isSystemDefault: true })], {
        hasMore: true,
        enforced: false,
        tier: "build",
      }),
    );
    expect(await readAssignableRoles("acme", "core-platform")).toMatchObject({
      ok: true,
      value: { enforced: false, tier: "build", more: true },
    });
  });

  it("carries a refused read across as denied (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "org.admin",
    });
    expect(await readAssignableRoles("acme", "core-platform")).toEqual({
      ok: false,
      reason: "denied",
      code: "org.admin",
    });
  });
});

describe("readCostCenters", () => {
  it("offers the organization's live labels, by public id and label", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: {
        costCenters: [
          {
            id: "cct_eng",
            label: "ENG-1001",
            description: "Platform",
            agents: 2,
            workspaces: 1,
          },
          {
            id: "cct_ops",
            label: "OPS-2",
            description: null,
            agents: 0,
            workspaces: 0,
          },
        ],
      },
    });
    expect(await readCostCenters("acme", "core-platform")).toEqual({
      ok: true,
      value: [
        { id: "cct_eng", label: "ENG-1001" },
        { id: "cct_ops", label: "OPS-2" },
      ],
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: costCenterList,
      input: {},
      page: "agents",
    });
  });

  it("returns a refused read as denied (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "spend.cost_center.list",
    });
    expect(await readCostCenters("acme", "core-platform")).toMatchObject({
      ok: false,
      reason: "denied",
    });
  });
});

describe("setAgentCostCenter", () => {
  it("charges the agent by slug to the label and answers the stored spelling", async () => {
    invoke.mockResolvedValue({
      target: "agent",
      id: "agt_releasebot",
      costCenter: "ENG-1001",
    });
    expect(
      await setAgentCostCenter(
        "acme",
        "core-platform",
        "release-bot",
        " eng-1001 ",
      ),
    ).toEqual({ ok: true, value: { costCenter: "ENG-1001" } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "set_cost_center",
      { target: "agent", agent: "release-bot", costCenter: "eng-1001" },
      expect.objectContaining(TENANT),
    );
  });

  it("clears the label when the box is empty, so the agent inherits the workspace's", async () => {
    invoke.mockResolvedValue({
      target: "agent",
      id: "agt_releasebot",
      costCenter: null,
    });
    expect(
      await setAgentCostCenter("acme", "core-platform", "release-bot", ""),
    ).toEqual({ ok: true, value: { costCenter: null } });
    expect(invoke).toHaveBeenCalledWith(
      "set_cost_center",
      { target: "agent", agent: "release-bot", costCenter: null },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a blank agent before the kernel runs (negative)", async () => {
    expect(
      await setAgentCostCenter("acme", "core-platform", " ", "ENG-1001"),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "agent",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("set_cost_center"));
    expect(
      await setAgentCostCenter(
        "acme",
        "core-platform",
        "release-bot",
        "ENG-1001",
      ),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("assignAgentRole", () => {
  it("assigns the named role for the workspace viewer", async () => {
    invoke.mockResolvedValue({
      assigned: true,
      alreadyAssigned: false,
      agentId: "agt_releasebot",
      roleId: "rol_contributor",
      roleName: "Agent Contributor",
    });
    expect(
      await assignAgentRole(
        "acme",
        "core-platform",
        "agt_releasebot",
        "Agent Contributor",
      ),
    ).toEqual({
      ok: true,
      value: { roleName: "Agent Contributor", alreadyAssigned: false },
    });
    expect(invoke).toHaveBeenCalledWith(
      "assign_agent_role",
      { agentId: "agt_releasebot", roleName: "Agent Contributor" },
      expect.objectContaining(TENANT),
    );
  });

  it("reports a role the agent already held, which wrote nothing", async () => {
    invoke.mockResolvedValue({
      assigned: true,
      alreadyAssigned: true,
      agentId: "agt_releasebot",
      roleId: "rol_contributor",
      roleName: "Agent Contributor",
    });
    expect(
      await assignAgentRole(
        "acme",
        "core-platform",
        "agt_releasebot",
        "Agent Contributor",
      ),
    ).toMatchObject({ ok: true, value: { alreadyAssigned: true } });
  });

  it("refuses a blank role before the kernel runs (negative)", async () => {
    expect(
      await assignAgentRole("acme", "core-platform", "agt_releasebot", "   "),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "roleName",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("assign_agent_role"));
    expect(
      await assignAgentRole(
        "acme",
        "core-platform",
        "agt_releasebot",
        "Agent Operator",
      ),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("revokeAgentRole", () => {
  it("revokes the named role for the workspace viewer", async () => {
    invoke.mockResolvedValue({
      revoked: true,
      agentId: "agt_releasebot",
      roleName: "Agent Operator",
    });
    expect(
      await revokeAgentRole(
        "acme",
        "core-platform",
        "agt_releasebot",
        "Agent Operator",
      ),
    ).toEqual({
      ok: true,
      value: { roleName: "Agent Operator", revoked: true },
    });
    expect(invoke).toHaveBeenCalledWith(
      "revoke_agent_role",
      { agentId: "agt_releasebot", roleName: "Agent Operator" },
      expect.objectContaining(TENANT),
    );
  });

  // A second click on a page whose rows are stale: idempotent, not an error.
  it("reports a role the agent did not hold as revoked false", async () => {
    invoke.mockResolvedValue({
      revoked: false,
      agentId: "agt_releasebot",
      roleName: "Agent Operator",
    });
    expect(
      await revokeAgentRole(
        "acme",
        "core-platform",
        "agt_releasebot",
        "Agent Operator",
      ),
    ).toMatchObject({ ok: true, value: { revoked: false } });
  });

  it("refuses a blank role before the kernel runs (negative)", async () => {
    expect(
      await revokeAgentRole("acme", "core-platform", "agt_releasebot", ""),
    ).toMatchObject({ ok: false, reason: "invalid", field: "roleName" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a denial as denied (negative)", async () => {
    invoke.mockRejectedValue(denied("revoke_agent_role"));
    expect(
      await revokeAgentRole(
        "acme",
        "core-platform",
        "agt_releasebot",
        "Agent Operator",
      ),
    ).toMatchObject({ ok: false, reason: "denied" });
  });
});
