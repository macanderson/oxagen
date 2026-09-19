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

  it("falls back to the default zone when the saved one cannot be read (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "error",
      code: "control_plane_unavailable",
      status: 503,
    });
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", {
      ...good,
      validFrom: "2026-01-15",
      validTo: "2026-01-15",
    });
    // Pacific is the default every page prints in, so the window agrees with
    // the dates on screen rather than silently becoming a UTC day.
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      validFrom: "2026-01-15T08:00:00.000Z",
      validTo: "2026-01-16T07:59:59.999Z",
    });
  });

  it("falls back to the default zone for a saved one this runtime cannot format in (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: { timezone: "Mars/Olympus_Mons" },
    });
    invoke.mockResolvedValue({ ...mandateOutput(), status: "draft" });
    await requestMandate("acme", "core-platform", {
      ...good,
      validFrom: "2026-01-15",
      validTo: "2026-01-15",
    });
    expect(invoke.mock.calls[0]?.[1]).toMatchObject({
      validFrom: "2026-01-15T08:00:00.000Z",
      validTo: "2026-01-16T07:59:59.999Z",
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
