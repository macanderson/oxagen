/**
 * Unit tests for automation, skill, workspace, privacy, code, and api.key routes:
 *   automation.list, automation.create, automation.enable, automation.disable,
 *   automation.trigger, automation.update,
 *   skill.author, skill.create, skill.enable, skill.metrics.read,
 *   skill.version.activate, skill.version.get, skill.version.list,
 *   skill.version.upload, skill.workspace.list, skill.workspace.install,
 *   workspace.member.list, workspace.invite.send,
 *   workspace.settings.read, workspace.settings.write,
 *   workspace.model.settings.read, workspace.model.settings.write,
 *   privacy.data.erase, privacy.data.export,
 *   code.diff, code.format, code.patch,
 *   api.key.rotate, research.swarm.start
 *
 * Pattern: mock at the adapter seam, assert happy path forwards invoke result
 * as JSON, invoke called once with correct contract name + surface "api".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return { ...real, invoke: mocks.invoke, clearHandlersForTests: vi.fn() };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: mocks.verifyStripeSignature,
    processStripeEvent: mocks.processStripeEvent,
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileNotFoundError";
    }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileForbiddenError";
    }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const BASE = "/v1/test-org/test-ws";

function post(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return makeRequest(`${BASE}${path}`, {
    headers: { authorization: bearerHeader("oxk_key") },
  });
}

function patch(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "PATCH",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── automation.list ───────────────────────────────────────────────────────────

describe("automation.list route", () => {
  const PATH = "/automation/list";

  it("happy path GET: returns 200 with automations", async () => {
    mocks.invoke.mockResolvedValue([]);

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'list_automations' and surface 'api'", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_automations");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?workspace_id is forwarded to invoke", async () => {
    await app.fetch(get(`${PATH}?workspace_id=ws-1`));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.workspace_id).toBe("ws-1");
  });
});

// ── automation.create ─────────────────────────────────────────────────────────

describe("automation.create route", () => {
  const PATH = "/automation/create";
  const VALID_BODY = {
    name: "Daily Report",
    triggerType: "schedule",
    triggerConfig: { schedule: "0 9 * * 1-5" },
    capabilities: [{ name: "get_graph_stats", input: {} }],
  };

  it("happy path POST: returns 200", async () => {
    const invokeResult = {
      id: "plt-1",
      name: "Daily Report",
      status: "active",
      enabled: true,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'create_automation' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_automation");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes name and triggerType to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.name).toBe("Daily Report");
    expect(body.triggerType).toBe("schedule");
  });

  it("empty name → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { ...VALID_BODY, name: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── automation.enable ─────────────────────────────────────────────────────────

describe("automation.enable route", () => {
  const PATH = "/automation/enable";

  it("happy path POST: returns 200", async () => {
    mocks.invoke.mockResolvedValue({
      automation_id: "plt-1",
      enabled: true,
      status: "active",
    });

    const res = await app.fetch(post(PATH, { automation_id: "plt-1" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'enable_automation' and surface 'api'", async () => {
    await app.fetch(post(PATH, { automation_id: "plt-1" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("enable_automation");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("missing automation_id → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── automation.disable ────────────────────────────────────────────────────────

describe("automation.disable route", () => {
  const PATH = "/automation/disable";

  it("happy path POST: returns 200", async () => {
    mocks.invoke.mockResolvedValue({
      automation_id: "plt-1",
      enabled: false,
      status: "paused",
    });

    const res = await app.fetch(post(PATH, { automation_id: "plt-1" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'disable_automation' and surface 'api'", async () => {
    await app.fetch(post(PATH, { automation_id: "plt-2" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("disable_automation");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("missing automation_id → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── automation.trigger ────────────────────────────────────────────────────────

describe("automation.trigger route", () => {
  const PATH = "/automation/trigger";

  it("happy path POST: returns 200 with execution info", async () => {
    mocks.invoke.mockResolvedValue({
      execution_id: "exec-1",
      status: "running",
    });

    const res = await app.fetch(post(PATH, { automation_id: "plt-1" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'trigger_automation' and surface 'api'", async () => {
    await app.fetch(
      post(PATH, { automation_id: "plt-1", payload: { key: "value" } }),
    );
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("trigger_automation");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes automation_id and optional payload to invoke", async () => {
    await app.fetch(
      post(PATH, { automation_id: "plt-1", payload: { topic: "sales" } }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.automation_id).toBe("plt-1");
    expect(body.payload).toEqual({ topic: "sales" });
  });
});

// ── automation.update ─────────────────────────────────────────────────────────

describe("automation.update route", () => {
  const PATH = "/automation/update";

  it("happy path PATCH: returns 200", async () => {
    mocks.invoke.mockResolvedValue({
      automation_id: "plt-1",
      name: "Updated Report",
      description: null,
      status: "active",
      triggerType: "schedule",
      enabled: true,
    });

    const res = await app.fetch(
      patch(PATH, { automation_id: "plt-1", name: "Updated Report" }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'update_automation' and surface 'api'", async () => {
    await app.fetch(patch(PATH, { automation_id: "plt-1" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("update_automation");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("missing automation_id → 400, invoke not called", async () => {
    const res = await app.fetch(patch(PATH, { name: "New name" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── skill.author ──────────────────────────────────────────────────────────────

describe("skill.author route", () => {
  const PATH = "/skill/author";
  const VALID_BODY = {
    prompt: "Create a skill for reviewing code quality and security",
  };

  it("happy path POST: returns 200 with authored skill", async () => {
    const invokeResult = {
      slug: "code-quality-review",
      content: 'schema_version = 1\nkind = "skill"\n',
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'author_skill' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("author_skill");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes prompt and optional nameHint to invoke", async () => {
    await app.fetch(
      post(PATH, {
        prompt: "A skill for data analysis workflows",
        nameHint: "data-analysis",
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.prompt).toBe("A skill for data analysis workflows");
    expect(body.nameHint).toBe("data-analysis");
  });

  it("prompt too short → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { prompt: "short" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── skill.create ──────────────────────────────────────────────────────────────

describe("skill.create route", () => {
  const PATH = "/skill/create";
  const VALID_BODY = {
    content:
      'schema_version = 1\nkind = "skill"\nname = "code-review"\ndescription = "Reviews code"\ninstructions = "Review code"\nreferences = []\n',
  };

  it("happy path POST: returns 200 with skill id", async () => {
    const invokeResult = {
      id: "skl-1",
      name: "Code Review",
      slug: "code-review",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'create_skill' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_skill");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes canonical content to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.content).toContain('name = "code-review"');
  });

  it("missing content → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── skill.enable ──────────────────────────────────────────────────────────────

describe("skill.enable route", () => {
  const PATH = "/skill/enable";

  it("happy path POST: returns 200", async () => {
    mocks.invoke.mockResolvedValue({
      skill_id: "skl-1",
      slug: "code-review",
      enabled: true,
    });

    const res = await app.fetch(
      post(PATH, { skill_id: "skl-1", enabled: true }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'set_skill_enabled' and surface 'api'", async () => {
    await app.fetch(post(PATH, { skill_id: "skl-1", enabled: false }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("set_skill_enabled");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes skill_id and enabled to invoke", async () => {
    await app.fetch(post(PATH, { skill_id: "skl-2", enabled: true }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.skill_id).toBe("skl-2");
    expect(body.enabled).toBe(true);
  });

  it("missing enabled → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { skill_id: "skl-1" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── skill.metrics.read ────────────────────────────────────────────────────────

describe("skill.metrics.read route", () => {
  const PATH = "/skill/metrics/read";

  it("happy path GET: returns 200 with metrics", async () => {
    mocks.invoke.mockResolvedValue({ skills: [] });

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'get_skill_metrics' and surface 'api'", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_skill_metrics");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?skill_id is forwarded as skillId to invoke", async () => {
    await app.fetch(get(`${PATH}?skill_id=skl-1`));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.skillId).toBe("skl-1");
  });

  it("no ?skill_id → skillId is undefined in invoke input", async () => {
    await app.fetch(get(PATH));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.skillId).toBeUndefined();
  });
});

// ── skill.version.activate ────────────────────────────────────────────────────

describe("skill.version.activate route", () => {
  const PATH = "/skill/version/activate";

  it("happy path POST: returns 200", async () => {
    mocks.invoke.mockResolvedValue({
      skillId: "skl-1",
      activeVersionNumber: 3,
      activatedAt: "2026-06-28T00:00:00.000Z",
    });

    const res = await app.fetch(
      post(PATH, { skillId: "skl-1", versionNumber: 3 }),
    );
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'activate_skill_version' and surface 'api'", async () => {
    await app.fetch(post(PATH, { skillId: "skl-1", versionNumber: 1 }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("activate_skill_version");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("versionNumber < 1 → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { skillId: "skl-1", versionNumber: 0 }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── skill.version.get ─────────────────────────────────────────────────────────

describe("skill.version.get route", () => {
  const PATH = "/skill/version/get";

  it("happy path GET: returns 200 with version", async () => {
    mocks.invoke.mockResolvedValue({
      id: "slv-1",
      skill_id: "skl-1",
      versionNumber: 2,
      isLatest: true,
      isActive: true,
    });

    const res = await app.fetch(get(`${PATH}?skill_id=skl-1&version_id=slv-1`));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'get_skill_version' and surface 'api'", async () => {
    await app.fetch(get(`${PATH}?skill_id=skl-1&version_id=slv-1`));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_skill_version");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes skill_id and version_id to invoke", async () => {
    await app.fetch(get(`${PATH}?skill_id=skl-abc&version_id=slv-xyz`));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.skill_id).toBe("skl-abc");
    expect(body.version_id).toBe("slv-xyz");
  });
});

// ── skill.version.list ────────────────────────────────────────────────────────

describe("skill.version.list route", () => {
  const PATH = "/skill/version/list";

  it("happy path GET: returns 200 with versions", async () => {
    mocks.invoke.mockResolvedValue({ versions: [], total: 0 });

    const res = await app.fetch(get(`${PATH}?skill_id=skl-1`));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'list_skill_versions' and surface 'api'", async () => {
    await app.fetch(get(`${PATH}?skill_id=skl-1`));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_skill_versions");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes skill_id, limit, offset to invoke", async () => {
    await app.fetch(get(`${PATH}?skill_id=skl-1&limit=10&offset=5`));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.skill_id).toBe("skl-1");
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(5);
  });
});

// ── skill.version.upload ──────────────────────────────────────────────────────

describe("skill.version.upload route", () => {
  const PATH = "/skill/version/upload";
  const VALID_BODY = {
    skill_id: "skl-1",
    content: 'schema_version = 1\nkind = "skill"\nname = "code-review"\n',
  };

  it("happy path POST: returns 200", async () => {
    mocks.invoke.mockResolvedValue({
      versionNumber: 3,
      skillId: "skl-1",
      isActive: true,
    });

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'upload_skill_version' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upload_skill_version");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes skill_id and content to invoke", async () => {
    await app.fetch(post(PATH, { ...VALID_BODY, activate: false }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.skill_id).toBe("skl-1");
    expect(body.content).toContain("schema_version");
    expect(body.activate).toBe(false);
  });

  it("missing content (empty string) → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { skill_id: "skl-1", content: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── workspace.member.list ─────────────────────────────────────────────────────

describe("workspace.member.list route", () => {
  const PATH = "/workspace/member/list";

  it("happy path GET: returns 200 with members", async () => {
    mocks.invoke.mockResolvedValue([
      {
        id: "usr-1",
        email: "alice@test.com",
        role: "admin",
        joined_at: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'list_workspace_members' and surface 'api'", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_workspace_members");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("?workspace_id is forwarded to invoke", async () => {
    await app.fetch(get(`${PATH}?workspace_id=ws-1`));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.workspace_id).toBe("ws-1");
  });

  it("no ?workspace_id → workspace_id is undefined in invoke input", async () => {
    await app.fetch(get(PATH));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.workspace_id).toBeUndefined();
  });
});

// ── workspace.invite.send ─────────────────────────────────────────────────────

describe("workspace.invite.send route", () => {
  const PATH = "/workspace/invite/send";

  it("happy path POST: returns 200 with invite", async () => {
    mocks.invoke.mockResolvedValue({
      id: "inv-1",
      status: "pending",
      expires_at: "2026-07-28T00:00:00.000Z",
    });

    const res = await app.fetch(post(PATH, { email: "bob@test.com" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'send_workspace_invite' and surface 'api'", async () => {
    await app.fetch(post(PATH, { email: "carol@test.com", role: "admin" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("send_workspace_invite");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes email and optional role/message to invoke", async () => {
    await app.fetch(
      post(PATH, {
        email: "dan@test.com",
        role: "member",
        message: "Join us!",
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.email).toBe("dan@test.com");
    expect(body.role).toBe("member");
    expect(body.message).toBe("Join us!");
  });

  it("invalid email → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── workspace.model.settings.read ────────────────────────────────────────────

describe("workspace.model.settings.read route", () => {
  const PATH = "/workspace/model-settings";

  it("happy path GET: returns 200 with settings", async () => {
    mocks.invoke.mockResolvedValue({
      defaultTextTier: "balanced",
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'get_model_settings' and surface 'api'", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_model_settings");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes empty input to invoke", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
  });
});

// ── workspace.model.settings.write ───────────────────────────────────────────

describe("workspace.model.settings.write route", () => {
  const PATH = "/workspace/model-settings";

  it("happy path PATCH: returns 200 with updated settings", async () => {
    mocks.invoke.mockResolvedValue({
      defaultTextTier: "fast",
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
    });

    const res = await app.fetch(patch(PATH, { defaultTextTier: "fast" }));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'update_model_settings' and surface 'api'", async () => {
    await app.fetch(patch(PATH, { defaultTextModel: "claude-3-5-haiku" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("update_model_settings");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes optional model fields to invoke", async () => {
    await app.fetch(
      patch(PATH, { defaultTextTier: "precise", defaultImageModel: null }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.defaultTextTier).toBe("precise");
    expect(body.defaultImageModel).toBeNull();
  });
});

// ── privacy.data.erase ────────────────────────────────────────────────────────

describe("privacy.data.erase route", () => {
  const PATH = "/privacy/erase";
  const VALID_BODY = { scope: "user", confirm: true };

  it("happy path POST: returns 202 with erasure request", async () => {
    const invokeResult = {
      requestId: "55555555-5555-5555-5555-555555555555",
      status: "queued",
      effectiveAt: "2026-07-05T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'erase_data' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("erase_data");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes scope and confirm to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.scope).toBe("user");
    expect(body.confirm).toBe(true);
  });

  it("missing confirm → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { scope: "user" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invalid scope → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { scope: "workspace", confirm: true }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── privacy.data.export ───────────────────────────────────────────────────────

describe("privacy.data.export route", () => {
  const PATH = "/privacy/export";

  it("happy path POST: returns 202 with export request", async () => {
    const invokeResult = {
      exportId: "66666666-6666-6666-6666-666666666666",
      status: "queued",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { scope: "user" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'export_data' and surface 'api'", async () => {
    await app.fetch(post(PATH, { scope: "user" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("export_data");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes scope and optional orgId to invoke", async () => {
    const orgId = "77777777-7777-7777-7777-777777777777";
    await app.fetch(post(PATH, { scope: "org", orgId }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.scope).toBe("org");
    expect(body.orgId).toBe(orgId);
  });

  it("invalid scope → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { scope: "all" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── code.diff ─────────────────────────────────────────────────────────────────

describe("code.diff route", () => {
  const PATH = "/code/diff";
  const VALID_BODY = {
    before: "const x = 1;\n",
    after: "const x = 2;\n",
    path: "src/foo.ts",
  };

  it("happy path POST: returns 200 with diff", async () => {
    const invokeResult = {
      diff: "--- src/foo.ts\n+++ src/foo.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'diff_code' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("diff_code");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes before, after, path to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.before).toBe("const x = 1;\n");
    expect(body.after).toBe("const x = 2;\n");
    expect(body.path).toBe("src/foo.ts");
  });

  it("missing after → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { before: "const x = 1;\n" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── code.format ───────────────────────────────────────────────────────────────

describe("code.format route", () => {
  const PATH = "/code/format";
  const VALID_BODY = { language: "json", source: '{"x":1}' };

  it("happy path POST: returns 200 with formatted code", async () => {
    mocks.invoke.mockResolvedValue({ formatted: '{\n  "x": 1\n}\n' });

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'format_code' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("format_code");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes language and source to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.language).toBe("json");
    expect(body.source).toBe('{"x":1}');
  });

  it("invalid language → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { language: "typescript", source: "const x=1;" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("empty source → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { language: "json", source: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── code.patch ────────────────────────────────────────────────────────────────

describe("code.patch route", () => {
  const PATH = "/code/patch";
  const VALID_BODY = {
    files: { "src/foo.ts": "const x = 1;\n" },
    diff: "--- src/foo.ts\n+++ src/foo.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;",
  };

  it("happy path POST: returns 200 with patched files", async () => {
    mocks.invoke.mockResolvedValue({
      files: { "src/foo.ts": "const x = 2;\n" },
      applied: 1,
      failed: 0,
    });

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
  });

  it("calls invoke with 'patch_code' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("patch_code");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes files and diff to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.files).toEqual({ "src/foo.ts": "const x = 1;\n" });
    expect(body.diff).toContain("--- src/foo.ts");
  });

  it("empty diff → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { files: { "src/foo.ts": "const x = 1;" }, diff: "" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── api.key.rotate ────────────────────────────────────────────────────────────

describe("api.key.rotate route", () => {
  const PATH = "/api-keys/rotate";

  it("happy path POST: returns 201 with new key", async () => {
    const invokeResult = {
      publicId: "aky-new",
      keyHint: "oxk_...",
      revokedAt: "2026-06-28T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { keyPublicId: "aky-old" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'rotate_api_key' and surface 'api'", async () => {
    await app.fetch(post(PATH, { keyPublicId: "aky-old" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("rotate_api_key");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes keyPublicId and optional name to invoke", async () => {
    await app.fetch(
      post(PATH, { keyPublicId: "aky-123", name: "New Key Name" }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.keyPublicId).toBe("aky-123");
    expect(body.name).toBe("New Key Name");
  });

  it("missing keyPublicId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── research.swarm.start ──────────────────────────────────────────────────────

describe("research.swarm.start route", () => {
  const PATH = "/research/swarm/start";

  it("happy path POST: returns 202 with swarm info", async () => {
    const invokeResult = {
      dispatchId: "fan-swarm-1",
      topic: "AI trends 2026",
      depth: "medium",
      totalTasks: 8,
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { topic: "AI trends 2026" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'start_research_swarm' and surface 'api'", async () => {
    await app.fetch(post(PATH, { topic: "LLM pricing models" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("start_research_swarm");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes topic and optional depth/maxParallel to invoke", async () => {
    await app.fetch(
      post(PATH, { topic: "Vector databases", depth: "deep", maxParallel: 10 }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.topic).toBe("Vector databases");
    expect(body.depth).toBe("deep");
    expect(body.maxParallel).toBe(10);
  });

  it("empty topic → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { topic: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
