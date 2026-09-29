// draft.save.test.ts: save_studio_draft and get_studio_draft over a fake store.
// store.pg.test.ts covers the revision rule against Postgres.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import {
  studioSourceBytes,
  type StudioDraftOp,
  type StudioSource,
  type ToolStudioDraftSaveInput,
} from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { TEST_CTX } from "../../test-utils/fixtures";
import { createGetStudioDraftHandler } from "./draft.get";
import { createSaveStudioDraftHandler } from "./draft.save";
import type { SaveStudioDraftInput, StoredStudioDraft, StudioDraftStore } from "./store";

const SCOPE = { orgId: TEST_CTX.orgId, workspaceId: TEST_CTX.workspaceId };
const UPDATED_AT = new Date("2026-09-28T12:00:00Z");
/** The billing fixture's server.toml, read when a test asks for it. */
function serverToml(): string {
  return readFileSync(
    new URL("../../../../mcp-studio/fixtures/servers/billing/server.toml", import.meta.url),
    "utf8",
  );
}
const SOURCE: StudioSource = {
  type: "openapi",
  files: [{ path: "openapi.yaml", text: "openapi: 3.1.0\ninfo: { title: Billing, version: '2' }\npaths: {}\n" }],
  entry: "openapi.yaml",
};

const CLASSIFY: StudioDraftOp = {
  kind: "classify",
  tool: "list_charges",
  risk: "low",
  sideEffect: "read",
  egress: "org_tenant",
  impacts: [],
};

function testOp(request: Record<string, unknown>): StudioDraftOp {
  return {
    kind: "test",
    tool: "list_charges",
    environment: "sandbox",
    args: "{}",
    request: JSON.stringify(request),
    raw: JSON.stringify({ status: 200, body: { data: [] } }),
    shaped: JSON.stringify({ data: [] }),
  };
}

function stored(fields: Partial<StoredStudioDraft> = {}): StoredStudioDraft {
  return {
    server: "billing",
    serverId: null,
    ops: [],
    serverToml: null,
    source: null,
    revision: 1,
    pr: null,
    updatedAt: UPDATED_AT,
    ...fields,
  };
}

function fakeStore(current: StoredStudioDraft | null = null) {
  return {
    get: vi.fn(async () => current),
    save: vi.fn(
      async (_scope: unknown, input: SaveStudioDraftInput): Promise<StoredStudioDraft> =>
        stored({
          server: input.server,
          serverId: input.serverId ?? null,
          ops: input.ops,
          serverToml: input.serverToml ?? null,
          source: input.source ?? null,
          revision: (input.revision ?? 0) + 1,
        }),
    ),
    recordPr: vi.fn(async () => undefined),
  } satisfies StudioDraftStore;
}

function forbidden(): HandlerError {
  return new HandlerError({ code: "forbidden", reason: "role_required", message: "You need the Admin role." });
}

async function refusal(promise: Promise<unknown>): Promise<HandlerError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HandlerError) return err;
    throw err;
  }
  throw new Error("The handler did not refuse.");
}

function saveRig(authorize: () => Promise<string | null> = async () => "u_7") {
  const store = fakeStore();
  const auth = vi.fn(authorize);
  const handler = createSaveStudioDraftHandler({ store, authorize: auth });
  return { store, authorize: auth, run: (input: ToolStudioDraftSaveInput) => handler(input, TEST_CTX) };
}

describe("save_studio_draft", () => {
  it("stores the ops, server.toml, and source with the person who saved, and returns the source summarized", async () => {
    const { store, run } = saveRig();
    const toml = serverToml();
    const view = await run({ server: "billing", ops: [CLASSIFY], serverToml: toml, source: SOURCE, revision: 0 });

    expect(store.save).toHaveBeenCalledWith(SCOPE, {
      server: "billing",
      serverId: undefined,
      ops: [CLASSIFY],
      serverToml: toml,
      source: SOURCE,
      revision: 0,
      actorUserId: "u_7",
    });
    expect(view).toStrictEqual({
      server: "billing",
      serverId: null,
      ops: [CLASSIFY],
      serverToml: toml,
      source: { type: "openapi", bytes: studioSourceBytes(SOURCE) },
      revision: 1,
      pr: null,
      updatedAt: "2026-09-28T12:00:00.000Z",
    });
    expect(JSON.stringify(view)).not.toContain("openapi: 3.1.0");
  });

  it("saves ops alone without checking a server.toml", async () => {
    const { store, run } = saveRig();
    await run({ server: "billing", ops: [CLASSIFY] });
    expect(store.save).toHaveBeenCalledOnce();
    expect(store.save.mock.calls[0]?.[1]).toMatchObject({ serverToml: undefined, source: undefined, revision: undefined });
  });

  it("asks who may save before it reads the input", async () => {
    const { store, run } = saveRig(async () => {
      throw forbidden();
    });
    const err = await refusal(run({ server: "billing", ops: [testOp({ headers: { cookie: "sid=1" } })] }));
    expect(err.code).toBe("forbidden");
    expect(store.save).not.toHaveBeenCalled();
  });

  it("refuses a saved test that carries a credential and stores nothing", async () => {
    const { store, run } = saveRig();
    const err = await refusal(
      run({ server: "billing", ops: [testOp({ method: "GET", path: "/charges", headers: { "Proxy-Authorization": "Basic eDp5" } })] }),
    );
    expect(err.reason).toBe("test_holds_credential");
    expect(err.message).toContain("carries a proxy-authorization header");
    expect(err.message).not.toContain("eDp5");
    expect(store.save).not.toHaveBeenCalled();
  });

  it("refuses a server.toml that does not validate", async () => {
    const { store, run } = saveRig();
    const err = await refusal(run({ server: "billing", ops: [], serverToml: 'name = "billing"\n' }));
    expect(err.reason).toBe("server_toml_invalid");
    expect(err.message).toMatch(/^server\.toml does not parse\. /);
    expect(store.save).not.toHaveBeenCalled();
  });

  it("refuses a server.toml that names another folder", async () => {
    const { store, run } = saveRig();
    const err = await refusal(run({ server: "payments", ops: [], serverToml: serverToml() }));
    expect(err.reason).toBe("server_name_mismatch");
    expect(err.message).toBe(
      "server.toml names billing, and the draft is for payments. The name in server.toml is the folder's name.",
    );
    expect(store.save).not.toHaveBeenCalled();
  });
});

describe("get_studio_draft", () => {
  function getRig(current: StoredStudioDraft | null, authorize: () => Promise<string | null> = async () => "u_7") {
    const store = fakeStore(current);
    const handler = createGetStudioDraftHandler({ store, authorize: vi.fn(authorize) });
    return { store, run: (server: string) => handler({ server }, TEST_CTX) };
  }

  it("returns null when the folder has no draft", async () => {
    const { store, run } = getRig(null);
    await expect(run("billing")).resolves.toStrictEqual({ draft: null });
    expect(store.get).toHaveBeenCalledWith(SCOPE, "billing");
  });

  it("returns the draft with its PR and its source summarized", async () => {
    const pr = { number: 41, url: "https://github.com/acme/steering/pull/41", branch: "tools/billing" };
    const { run } = getRig(stored({ ops: [CLASSIFY], source: SOURCE, revision: 3, pr }));
    const result = await run("billing");

    expect(result.draft).toMatchObject({
      server: "billing",
      ops: [CLASSIFY],
      source: { type: "openapi", bytes: studioSourceBytes(SOURCE) },
      revision: 3,
      pr,
      updatedAt: "2026-09-28T12:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("openapi: 3.1.0");
  });

  it("asks who may read before it reads the store", async () => {
    const { store, run } = getRig(stored(), async () => {
      throw forbidden();
    });
    expect((await refusal(run("billing"))).code).toBe("forbidden");
    expect(store.get).not.toHaveBeenCalled();
  });
});
