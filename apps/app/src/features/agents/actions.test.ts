// The agent writes through the real kernel seam: the viewer resolution and the
// kernel's invoke() are the only fakes, so each case shows what the person gets
// back and whether the capability ran — ok, invalid (refused before the kernel)
// and denied for every action (INV-19). request_mandate converts the amounts a
// person typed into micros and refuses a figure that is not a plain decimal
// before anything reaches the kernel.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MANDATE_ID, mandateOutput } from "@/test/mandate-outputs";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  commitAgentDefinition,
  requestMandate,
  retireAgent,
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

describe("a person the workspace refuses", () => {
  it.each([
    [
      "rotateAgentCredential",
      () => rotateAgentCredential("acme", "x", "agt_a"),
    ],
    ["setAgentSuspended", () => setAgentSuspended("acme", "x", "agt_a", true)],
    ["retireAgent", () => retireAgent("acme", "x", "agt_a")],
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
    consequenceTag: "moves_money",
    measure: "amount",
    kind: "amount" as const,
    currency: "usd",
    perCall: "250.00",
    perPeriod: "2,000.00",
    period: "monthly" as const,
    callsPerDay: "50",
    tools: "stripe__create_payment@*, aws_billing__purchase_savings_plan@2",
    purpose: "  monthly infrastructure invoices, PO-4471  ",
    validFrom: "2026-09-01",
    validTo: "2026-12-31",
  };
  const good = { ...draft, perPeriod: "2000.00" };

  it("asks for a draft with the amounts in micros and the tools split", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    expect(
      await requestMandate("acme", "core-platform", good),
    ).toEqual({
      ok: true,
      value: { mandateId: MANDATE_ID, status: "draft" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "request_mandate",
      {
        agentId: "agt_invoicebot",
        consequenceTags: ["moves_money"],
        limits: {
          amount: {
            perCall: "250000000",
            perPeriod: "2000000000",
            period: "monthly",
            currencyOrUnit: "USD",
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
          amount: {
            perPeriod: "2000000000",
            period: "monthly",
            currencyOrUnit: "USD",
          },
        },
      }),
    );
  });

  it.each([
    [{ currency: "dollars" }, "currency"],
    [{ measure: "  " }, "measure"],
    [{ consequenceTag: "" }, "consequenceTag"],
    [{ perCall: "", perPeriod: "" }, "perPeriod"],
    [{ perCall: "1,250" }, "perCall"],
    [{ perPeriod: "-5" }, "perPeriod"],
    [{ callsPerDay: "many" }, "callsPerDay"],
    [{ tools: " , " }, "tools"],
    [{ purpose: "   " }, "purpose"],
    [{ validFrom: "01/09/2026" }, "validFrom"],
    [{ validTo: "" }, "validTo"],
    [{ validFrom: "2026-12-31", validTo: "2026-09-01" }, "validTo"],
    // `calls` is the built-in measure: the gate reads one per call whatever a
    // limit says, so a money limit filed under it would be read as a ceiling
    // of that many calls, and the grant handler exempts it from the
    // measure-declared check that would otherwise catch it.
    [{ measure: "calls" }, "measure"],
    [{ measure: "  calls  " }, "measure"],
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

  it("stores a count limit in whole units, not scaled as money", async () => {
    // The sibling of the `calls` defect: a measure a tool declares as a count
    // (`rows`) whose limit went through the money scaling would be filed as
    // 50,000,000 — a millionfold more authority than the 50 that was asked
    // for — and the gate compares it against whole-unit counts.
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", {
      ...good,
      measure: "rows",
      kind: "count",
      currency: "rows",
      perCall: "50",
      perPeriod: "1000",
      callsPerDay: "",
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      limits: {
        rows: {
          perCall: "50",
          perPeriod: "1000",
          period: "monthly",
          currencyOrUnit: "rows",
        },
      },
    });
  });

  it.each([
    // A count is whole units: a decimal has no meaning in them.
    [
      {
        kind: "count" as const,
        currency: "rows",
        perCall: "",
        perPeriod: "12.5",
      },
      "perPeriod",
    ],
    [
      {
        kind: "count" as const,
        currency: "rows",
        perCall: "1.5",
        perPeriod: "",
      },
      "perCall",
    ],
    // A count denominated in a currency code could not be told from an amount
    // on the read, and an amount must name a real one.
    [{ kind: "count" as const, currency: "USD" }, "currency"],
    [{ kind: "count" as const, currency: "  " }, "currency"],
    [{ kind: "amount" as const, currency: "GAU" }, "currency"],
    [{ kind: "amount" as const, currency: "rows" }, "currency"],
  ])("refuses %j before the kernel runs (negative)", async (patch, field) => {
    expect(
      await requestMandate("acme", "core-platform", { ...good, ...patch }),
    ).toEqual({ ok: false, reason: "invalid", code: "invalid_input", field });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("runs the authority through the end of the last day it names", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", good);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      validFrom: "2026-09-01T00:00:00.000Z",
      validTo: "2026-12-31T23:59:59.999Z",
    });
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

  it("keeps a money limit and a calls-per-day limit apart, both intact", async () => {
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", good);
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      limits: {
        amount: {
          perCall: "250000000",
          perPeriod: "2000000000",
          period: "monthly",
          currencyOrUnit: "USD",
        },
        calls: { perPeriod: "50", period: "daily", currencyOrUnit: "calls" },
      },
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
