// tools-lane.handlers.test.ts — handler invocation tests for the Tools lane's
// tools (#2958): list_tool_versions, set_tool_classification, import_tools,
// list_credential_grants, set_kill_switch, list_kill_switches. Studio's three
// (lane M11, ADR-224) share the file: save_studio_draft, get_studio_draft, and
// open_studio_review.
//
// Pattern: vi.mock the kernel `invoke` and context seam `buildContext`. Each
// test asserts buildContext was called, invoke received the contract name,
// the args and { surface: "mcp" }, and the output passed the contract's
// output schema on the way back.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import listToolVersions, {
  metadata as listToolVersionsMeta,
  schema as listToolVersionsSchema,
} from "./tool.version.list";
import setToolClassification, {
  metadata as setToolClassificationMeta,
} from "./tool.classification.set";
import importTools, {
  metadata as importToolsMeta,
  schema as importToolsSchema,
} from "./tool.import";
import listCredentialGrants, {
  metadata as listCredentialGrantsMeta,
} from "./credential.grant.list";
import setKillSwitch, {
  metadata as setKillSwitchMeta,
} from "./kill_switch.set";
import listKillSwitches, {
  metadata as listKillSwitchesMeta,
} from "./kill_switch.list";
import saveStudioDraft, {
  metadata as saveStudioDraftMeta,
  schema as saveStudioDraftSchema,
} from "./tool.studio.draft.save";
import getStudioDraft, {
  metadata as getStudioDraftMeta,
} from "./tool.studio.draft.get";
import openStudioReview, {
  metadata as openStudioReviewMeta,
} from "./tool.studio.review.open";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("the nine tools carry their contract's name and hints", () => {
  it.each([
    [listToolVersionsMeta, "list_tool_versions", true, false],
    [setToolClassificationMeta, "set_tool_classification", false, false],
    [importToolsMeta, "import_tools", false, false],
    [listCredentialGrantsMeta, "list_credential_grants", true, false],
    [setKillSwitchMeta, "set_kill_switch", false, true],
    [listKillSwitchesMeta, "list_kill_switches", true, false],
    [saveStudioDraftMeta, "save_studio_draft", false, false],
    [getStudioDraftMeta, "get_studio_draft", true, false],
    [openStudioReviewMeta, "open_studio_review", false, false],
  ])("%s", (meta, name, readOnly, destructive) => {
    expect(meta.name).toBe(name);
    expect(meta.annotations?.readOnlyHint).toBe(readOnly);
    expect(meta.annotations?.destructiveHint).toBe(destructive);
  });

  it("import_tools exposes the base input fields (the refined contract input has no shape)", () => {
    expect(Object.keys(importToolsSchema).sort()).toEqual([
      "declarations",
      "serverId",
      "tools",
    ]);
    expect(Object.keys(listToolVersionsSchema).sort()).toEqual([
      "category",
      "cursor",
      "limit",
      "serverId",
    ]);
  });

  it("save_studio_draft exposes the base input fields (the refined contract input has no shape)", () => {
    expect(Object.keys(saveStudioDraftSchema).sort()).toEqual([
      "ops",
      "revision",
      "server",
      "serverId",
      "serverToml",
      "source",
    ]);
  });
});

describe("set_kill_switch", () => {
  it("invokes with the contract name and forwards the parsed output", async () => {
    const output = {
      switchId: "emd_1",
      on: true,
      changed: true,
      denyGeneration: { org: 3, workspace: 1 },
      grantsRevoked: 0,
    };
    mocks.invoke.mockResolvedValue(output);
    const args = {
      target: { kind: "class" as const, id: "moves_money" },
      on: true,
      reason: "incident",
    };
    const result = await setKillSwitch(args);
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_kill_switch",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual(output);
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ switchId: "emd_1" });
    await expect(
      setKillSwitch({
        target: { kind: "class", id: "moves_money" },
        on: true,
        reason: "x",
      }),
    ).rejects.toThrow();
  });
});

describe("list_kill_switches", () => {
  it("invokes with the contract name", async () => {
    const output = { denyGeneration: { org: 1, workspace: 0 }, switches: [] };
    mocks.invoke.mockResolvedValue(output);
    const result = await listKillSwitches({ onlyOn: true, limit: 10 });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_kill_switches",
      { onlyOn: true, limit: 10 },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual(output);
  });
});

describe("list_tool_versions, set_tool_classification, import_tools, list_credential_grants", () => {
  it("each invokes its contract by name with the args given", async () => {
    mocks.invoke.mockResolvedValue({ items: [], nextCursor: null });
    await listToolVersions({
      limit: 5,
      category: "moves_money",
      serverId: "mcs_linear",
      cursor: undefined,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "list_tool_versions",
      {
        limit: 5,
        category: "moves_money",
        serverId: "mcs_linear",
        cursor: undefined,
      },
      fakeCtx,
      { surface: "mcp" },
    );

    const classification = {
      sideEffect: "write" as const,
      egress: "third_party" as const,
      impacts: ["communicates_externally"],
      measures: {},
      dataClasses: [],
    };
    mocks.invoke.mockResolvedValue({
      toolVersionId: "tlv_1",
      riskGrade: "high",
      classification,
      classifiedAt: "2026-09-15T00:00:00.000Z",
    });
    await setToolClassification({
      toolVersionId: "tlv_1",
      riskGrade: "high",
      classification,
      reason: "mail",
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "set_tool_classification",
      expect.objectContaining({ toolVersionId: "tlv_1" }),
      fakeCtx,
      { surface: "mcp" },
    );

    mocks.invoke.mockResolvedValue({
      serverId: "mcs_1",
      importDigest: "d",
      tools: [],
    });
    await importTools({
      serverId: "mcs_1",
      tools: ["search"],
      declarations: undefined,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "import_tools",
      { serverId: "mcs_1", tools: ["search"], declarations: undefined },
      fakeCtx,
      { surface: "mcp" },
    );

    mocks.invoke.mockResolvedValue({ items: [], nextCursor: null });
    await listCredentialGrants({
      limit: 5,
      connectionId: "mcrd_1",
      cursor: undefined,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "list_credential_grants",
      { limit: 5, connectionId: "mcrd_1", cursor: undefined },
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("forbidden"));
    await expect(
      listToolVersions({
        limit: 5,
        category: undefined,
        serverId: undefined,
        cursor: undefined,
      }),
    ).rejects.toThrow("forbidden");
  });
});

describe("save_studio_draft, get_studio_draft, open_studio_review", () => {
  const draft = {
    server: "ledger",
    serverId: null,
    ops: [{ kind: "import" as const, tool: "search" }],
    serverToml: null,
    source: null,
    revision: 1,
    pr: null,
    updatedAt: "2026-09-28T00:00:00.000Z",
  };

  it("save_studio_draft invokes with the contract name and forwards the parsed draft", async () => {
    mocks.invoke.mockResolvedValue(draft);
    const args = {
      server: "ledger",
      serverId: undefined,
      ops: [{ kind: "import" as const, tool: "search" }],
      serverToml: undefined,
      source: undefined,
      revision: 0,
    };
    const result = await saveStudioDraft(args);
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "save_studio_draft",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual(draft);
  });

  it("get_studio_draft invokes with the contract name and passes a missing draft through", async () => {
    mocks.invoke.mockResolvedValue({ draft: null });
    const result = await getStudioDraft({ server: "ledger" });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_studio_draft",
      { server: "ledger" },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual({ draft: null });
  });

  it("open_studio_review invokes with the contract name and forwards the steering PR", async () => {
    const output = {
      number: 12,
      url: "https://github.com/acme/steering/pull/12",
      branch: "tools/ledger",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      imported: ["search"],
      removed: [],
      reclassified: [],
      tokens: { definitions: 120, budget: 4000 },
      findings: [],
    };
    mocks.invoke.mockResolvedValue(output);
    const result = await openStudioReview({ server: "ledger", revision: 1 });
    expect(mocks.invoke).toHaveBeenCalledWith(
      "open_studio_review",
      { server: "ledger", revision: 1 },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toEqual(output);
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ number: 12 });
    await expect(
      openStudioReview({ server: "ledger", revision: undefined }),
    ).rejects.toThrow();
    mocks.invoke.mockResolvedValue({ server: "ledger" });
    await expect(getStudioDraft({ server: "ledger" })).rejects.toThrow();
  });
});
