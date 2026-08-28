// sandbox-templates.handlers.test.ts — handler invocation tests for the
// sandbox.template.* and agent.environment.* MCP tools.
//
// Mocks the kernel `invoke` and the context seam `buildContext`, mirroring
// plugin.handlers.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

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

// ── shared fakes ─────────────────────────────────────────────────────────────

const fakeTemplate = {
  id: "tmpl_1",
  environmentId: "env_1",
  name: "Default",
  slug: "default",
  description: null,
  isDefault: true,
  isActive: true,
  provider: "modal" as const,
  runtime: null,
  resources: {},
  network: { mode: "public" as const },
  secretSelection: "all" as const,
  literalEnv: {},
  packages: [],
  tools: [],
};

const fakeManifest = {
  kind: "oxagen.sandbox-template" as const,
  version: 1 as const,
  name: "Default",
  slug: "default",
  provider: "modal" as const,
  resources: {},
  network: { mode: "public" as const },
  secretSelection: "all" as const,
  literalEnv: {},
  packages: [],
  tools: [],
  secretKeys: [],
};

const fakeBinding = {
  id: "bind_1",
  agentId: "agent_1",
  environmentId: "env_1",
  environmentName: "Env",
  environmentSlug: "env",
  sandboxTemplateId: null,
  sandboxTemplateName: null,
  isPrimary: true,
};

// ── sandbox.template.create ───────────────────────────────────────────────────

import handler_sandboxTemplateCreate, {
  schema as sandboxTemplateCreateSchema,
  metadata as sandboxTemplateCreateMetadata,
} from "./sandbox.template.create";

describe("sandbox.template.create handler", () => {
  it("exports schema and metadata", () => {
    expect(sandboxTemplateCreateSchema).toBeDefined();
    expect(sandboxTemplateCreateMetadata.name).toBe("create_sandbox_template");
  });

  it("calls invoke with create args", async () => {
    mocks.invoke.mockResolvedValue({ template: fakeTemplate });

    const args = {
      environmentId: "env_1",
      name: "Default",
      slug: "default",
      description: undefined,
      provider: undefined,
      runtime: undefined,
      resources: undefined,
      network: undefined,
      secretSelection: undefined,
      literalEnv: undefined,
      packages: undefined,
      tools: undefined,
      setAsDefault: undefined,
    };
    const result = await handler_sandboxTemplateCreate(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "create_sandbox_template",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ template: { id: "tmpl_1" } });
  });
});

// ── sandbox.template.list ─────────────────────────────────────────────────────

import handler_sandboxTemplateList, {
  schema as sandboxTemplateListSchema,
  metadata as sandboxTemplateListMetadata,
} from "./sandbox.template.list";

describe("sandbox.template.list handler", () => {
  it("exports schema and metadata", () => {
    expect(sandboxTemplateListSchema).toBeDefined();
    expect(sandboxTemplateListMetadata.name).toBe("list_sandbox_templates");
  });

  it("calls invoke with list args", async () => {
    mocks.invoke.mockResolvedValue({ templates: [fakeTemplate] });

    const args = { environmentId: undefined };
    await handler_sandboxTemplateList(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_sandbox_templates",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── sandbox.template.get ──────────────────────────────────────────────────────

import handler_sandboxTemplateGet, {
  schema as sandboxTemplateGetSchema,
  metadata as sandboxTemplateGetMetadata,
} from "./sandbox.template.get";

describe("sandbox.template.get handler", () => {
  it("exports schema and metadata", () => {
    expect(sandboxTemplateGetSchema).toBeDefined();
    expect(sandboxTemplateGetMetadata.name).toBe("get_sandbox_template");
  });

  it("calls invoke with get args", async () => {
    mocks.invoke.mockResolvedValue({ template: fakeTemplate });

    const args = { templateId: "tmpl_1" };
    await handler_sandboxTemplateGet(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_sandbox_template",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── sandbox.template.update ───────────────────────────────────────────────────

import handler_sandboxTemplateUpdate, {
  schema as sandboxTemplateUpdateSchema,
  metadata as sandboxTemplateUpdateMetadata,
} from "./sandbox.template.update";

describe("sandbox.template.update handler", () => {
  it("exports schema and metadata", () => {
    expect(sandboxTemplateUpdateSchema).toBeDefined();
    expect(sandboxTemplateUpdateMetadata.name).toBe("update_sandbox_template");
  });

  it("calls invoke with update args", async () => {
    mocks.invoke.mockResolvedValue({ template: fakeTemplate });

    const args = {
      templateId: "tmpl_1",
      name: "Renamed",
      slug: undefined,
      description: undefined,
      provider: undefined,
      runtime: undefined,
      resources: undefined,
      network: undefined,
      secretSelection: undefined,
      literalEnv: undefined,
      packages: undefined,
      isActive: undefined,
    };
    await handler_sandboxTemplateUpdate(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "update_sandbox_template",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── sandbox.template.delete ───────────────────────────────────────────────────

import handler_sandboxTemplateDelete, {
  schema as sandboxTemplateDeleteSchema,
  metadata as sandboxTemplateDeleteMetadata,
} from "./sandbox.template.delete";

describe("sandbox.template.delete handler", () => {
  it("exports schema and metadata", () => {
    expect(sandboxTemplateDeleteSchema).toBeDefined();
    expect(sandboxTemplateDeleteMetadata.name).toBe("delete_sandbox_template");
  });

  it("calls invoke with delete args", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });

    const args = { templateId: "tmpl_1" };
    await handler_sandboxTemplateDelete(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "delete_sandbox_template",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── sandbox.template.set_default ──────────────────────────────────────────────

import handler_sandboxTemplateSetDefault, {
  schema as sandboxTemplateSetDefaultSchema,
  metadata as sandboxTemplateSetDefaultMetadata,
} from "./sandbox.template.set_default";

describe("sandbox.template.set_default handler", () => {
  it("exports schema and metadata", () => {
    expect(sandboxTemplateSetDefaultSchema).toBeDefined();
    expect(sandboxTemplateSetDefaultMetadata.name).toBe(
      "set_default_sandbox_template",
    );
  });

  it("calls invoke with set_default args", async () => {
    mocks.invoke.mockResolvedValue({ template: fakeTemplate });

    const args = { templateId: "tmpl_1" };
    await handler_sandboxTemplateSetDefault(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_default_sandbox_template",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── sandbox.template.set_tools ─────────────────────────────────────────────────

import handler_sandboxTemplateSetTools, {
  schema as sandboxTemplateSetToolsSchema,
  metadata as sandboxTemplateSetToolsMetadata,
} from "./sandbox.template.set_tools";

describe("sandbox.template.set_tools handler", () => {
  it("exports schema and metadata", () => {
    expect(sandboxTemplateSetToolsSchema).toBeDefined();
    expect(sandboxTemplateSetToolsMetadata.name).toBe(
      "set_sandbox_template_tools",
    );
  });

  it("calls invoke with set_tools args", async () => {
    mocks.invoke.mockResolvedValue({ template: fakeTemplate });

    const args = { templateId: "tmpl_1", tools: [] };
    await handler_sandboxTemplateSetTools(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_sandbox_template_tools",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── sandbox.template.export ────────────────────────────────────────────────────

import handler_sandboxTemplateExport, {
  schema as sandboxTemplateExportSchema,
  metadata as sandboxTemplateExportMetadata,
} from "./sandbox.template.export";

describe("sandbox.template.export handler", () => {
  it("exports schema and metadata", () => {
    expect(sandboxTemplateExportSchema).toBeDefined();
    expect(sandboxTemplateExportMetadata.name).toBe("export_sandbox_template");
  });

  it("calls invoke with export args", async () => {
    mocks.invoke.mockResolvedValue({ manifest: fakeManifest });

    const args = { templateId: "tmpl_1" };
    await handler_sandboxTemplateExport(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "export_sandbox_template",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── sandbox.template.import ────────────────────────────────────────────────────

import handler_sandboxTemplateImport, {
  schema as sandboxTemplateImportSchema,
  metadata as sandboxTemplateImportMetadata,
} from "./sandbox.template.import";

describe("sandbox.template.import handler", () => {
  it("exports schema and metadata", () => {
    expect(sandboxTemplateImportSchema).toBeDefined();
    expect(sandboxTemplateImportMetadata.name).toBe("import_sandbox_template");
  });

  it("calls invoke with import args", async () => {
    mocks.invoke.mockResolvedValue({ template: fakeTemplate, warnings: [] });

    const args = {
      environmentId: "env_1",
      manifest: fakeManifest,
      slug: undefined,
      setAsDefault: undefined,
    };
    await handler_sandboxTemplateImport(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "import_sandbox_template",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── agent.environment.bind ────────────────────────────────────────────────────

import handler_agentEnvironmentBind, {
  schema as agentEnvironmentBindSchema,
  metadata as agentEnvironmentBindMetadata,
} from "./agent.environment.bind";

describe("agent.environment.bind handler", () => {
  it("exports schema and metadata", () => {
    expect(agentEnvironmentBindSchema).toBeDefined();
    expect(agentEnvironmentBindMetadata.name).toBe("bind_agent_environment");
  });

  it("calls invoke with bind args", async () => {
    mocks.invoke.mockResolvedValue({ binding: fakeBinding });

    const args = {
      agentId: "agent_1",
      environmentId: "env_1",
      sandboxTemplateId: undefined,
      isPrimary: undefined,
    };
    await handler_agentEnvironmentBind(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "bind_agent_environment",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── agent.environment.unbind ──────────────────────────────────────────────────

import handler_agentEnvironmentUnbind, {
  schema as agentEnvironmentUnbindSchema,
  metadata as agentEnvironmentUnbindMetadata,
} from "./agent.environment.unbind";

describe("agent.environment.unbind handler", () => {
  it("exports schema and metadata", () => {
    expect(agentEnvironmentUnbindSchema).toBeDefined();
    expect(agentEnvironmentUnbindMetadata.name).toBe(
      "unbind_agent_environment",
    );
  });

  it("calls invoke with unbind args", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });

    const args = { agentId: "agent_1", environmentId: "env_1" };
    await handler_agentEnvironmentUnbind(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "unbind_agent_environment",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── agent.environment.list ────────────────────────────────────────────────────

import handler_agentEnvironmentList, {
  schema as agentEnvironmentListSchema,
  metadata as agentEnvironmentListMetadata,
} from "./agent.environment.list";

describe("agent.environment.list handler", () => {
  it("exports schema and metadata", () => {
    expect(agentEnvironmentListSchema).toBeDefined();
    expect(agentEnvironmentListMetadata.name).toBe("list_agent_environments");
  });

  it("calls invoke with list args", async () => {
    mocks.invoke.mockResolvedValue({ bindings: [fakeBinding] });

    const args = { agentId: "agent_1" };
    await handler_agentEnvironmentList(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_agent_environments",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});
