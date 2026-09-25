// The creation wizards' actions through the kernel seam: the viewer and the two
// kernel calls are the fakes, so each case shows what the wizard gets back.
// The main repository read narrows the contract's output to the two fields a
// pull request names, and says null while none is bound. propose_skill sends
// exactly what the operator wrote, drops an empty rationale, and hands a
// failed check back as the conflict it was, with nothing else run.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireViewer, kernelRead, kernelWrite } = vi.hoisted(() => ({
  requireViewer: vi.fn(),
  kernelRead: vi.fn(),
  kernelWrite: vi.fn(),
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/server/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/kernel")>()),
  kernelRead,
  kernelWrite,
}));

const { skillPropose } = await import("@oxagen/oxagen/contracts/skill.propose");
const { contextProposalCreate } = await import(
  "@oxagen/oxagen/contracts/context.proposal.create"
);
const { contextSteeringFreshness } = await import(
  "@oxagen/oxagen/contracts/context.steering.freshness"
);
const { proposeRecord, proposeSkill, readMainRepository } = await import(
  "./actions"
);

const CTX = { orgSlug: "acme", wsSlug: "core-platform" };

const OPENED = {
  name: "release-notes",
  path: ".oxagen/skills/release-notes/SKILL.md",
  branch: "skills/release-notes",
  repository: "acme/platform",
  baseRef: "main",
  version: "0.1.0",
  replaces: null,
  digest: "sha256:abc",
  tokens: 120,
  budget: 6000,
  pullRequest: {
    number: 525,
    url: "https://github.com/acme/platform/pull/525",
  },
  // A field the wizard does not show, so the action must not pass it on.
  checks: ["frontmatter"],
};

beforeEach(() => {
  requireViewer.mockReset().mockResolvedValue(CTX);
  kernelRead.mockReset();
  kernelWrite.mockReset();
});

describe("readMainRepository", () => {
  it("reads get_steering_freshness for a workspace Member and keeps the name and branch", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: {
        repository: "acme/platform",
        defaultBranch: "main",
      },
    });
    const result = await readMainRepository("acme", "core-platform");
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelRead).toHaveBeenCalledWith(CTX, {
      contract: contextSteeringFreshness,
      input: {},
      page: "repositories",
    });
    expect(result).toEqual({
      ok: true,
      value: { fullName: "acme/platform", defaultRef: "main" },
    });
    expect(contextSteeringFreshness.defaultRoles.workspace.Member).toBe(
      "allow",
    );
    expect(contextSteeringFreshness.defaultEffect).toBe("allow");
  });

  it("answers null while the workspace binds no repository (empty)", async () => {
    kernelRead.mockResolvedValue({ ok: true, value: { repository: null } });
    expect(await readMainRepository("acme", "core-platform")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("passes a denied read on as denied (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "workspace.settings.read",
    });
    expect(await readMainRepository("acme", "core-platform")).toEqual({
      ok: false,
      reason: "denied",
      code: "workspace.settings.read",
    });
  });

  it("passes a failed read on with its code (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "error",
      code: "github_unreachable",
      status: 503,
    });
    const result = await readMainRepository("acme", "core-platform");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "github_unreachable" });
  });
});

describe("proposeRecord", () => {
  it("proposes create-only, so a new record never revises one that holds its slug (ADR-173)", async () => {
    kernelWrite.mockResolvedValue({
      ok: true,
      value: {
        proposalId: "prp_1",
        lineageId: "ctx.a.one",
        status: "proposed",
      },
    });
    const record = {
      lineageId: "ctx.a.one",
      label: "One",
      kind: "rule" as const,
      force: "must" as const,
      sharingScope: "workspace" as const,
      statement: "Do one thing.",
    };
    const result = await proposeRecord("acme", "core-platform", {
      record,
      rationale: "  Why  ",
    });
    expect(kernelWrite).toHaveBeenCalledWith(CTX, contextProposalCreate, {
      record,
      rationale: "Why",
      support: {},
      createOnly: true,
    });
    expect(result).toEqual({
      ok: true,
      value: { proposalId: "prp_1", lineageId: "ctx.a.one" },
    });
  });
});

describe("proposeSkill", () => {
  const input = {
    origin: "describe" as const,
    name: "release-notes",
    body: "---\nname: release-notes\nversion: 0.1.0\n---\n",
    files: [{ path: "examples/a.md", content: "a" }],
    rationale: "  How we cut release notes  ",
  };

  it("sends the file as written and returns the pull request", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: OPENED });
    const result = await proposeSkill("acme", "core-platform", input);
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelWrite).toHaveBeenCalledWith(CTX, skillPropose, {
      origin: "describe",
      name: "release-notes",
      body: input.body,
      files: [{ path: "examples/a.md", content: "a" }],
      rationale: "How we cut release notes",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest.number).toBe(525);
    expect(result.value).not.toHaveProperty("checks");
  });

  it("leaves an empty rationale out of the input (empty)", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: OPENED });
    await proposeSkill("acme", "core-platform", {
      ...input,
      origin: "upload",
      rationale: "   ",
    });
    const sent: unknown = kernelWrite.mock.calls[0]?.[2];
    expect(sent).not.toHaveProperty("rationale");
    expect(sent).toMatchObject({ origin: "upload" });
  });

  it("hands a failed check back as the conflict it was (negative)", async () => {
    const refusal = {
      ok: false,
      reason: "conflict",
      code: "skill_check_version",
    };
    kernelWrite.mockResolvedValue(refusal);
    expect(await proposeSkill("acme", "core-platform", input)).toEqual(refusal);
  });
});
