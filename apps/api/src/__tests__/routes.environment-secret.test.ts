/**
 * Unit tests for environment and secret vault route handlers:
 *   environment.create, environment.list, environment.get,
 *   environment.update, environment.delete, environment.set_default,
 *   secret.key.upsert, secret.key.list, secret.key.delete,
 *   secret.value.set, secret.value.unset, secret.reveal,
 *   secret.export, secret.import_env
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── environment.create ────────────────────────────────────────────────────────

describe("environment.create route", () => {
  const PATH = "/environment/create";
  const VALID_BODY = { name: "Production", slug: "production" };

  it("happy path POST: returns 200 with environment", async () => {
    const invokeResult = {
      environment: {
        id: "env-1",
        name: "Production",
        slug: "production",
        isDefault: false,
      },
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'create_environment' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_environment");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes name and slug to invoke", async () => {
    await app.fetch(
      post(PATH, { name: "Staging", slug: "staging", description: "Pre-prod" }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.name).toBe("Staging");
    expect(body.slug).toBe("staging");
    expect(body.description).toBe("Pre-prod");
  });

  it("missing name → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { slug: "staging" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing slug → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { name: "Staging" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── environment.list ──────────────────────────────────────────────────────────

describe("environment.list route", () => {
  const PATH = "/environment/list";

  it("happy path POST with empty body: returns 200", async () => {
    const invokeResult = { environments: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'list_environments' and surface 'api'", async () => {
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_environments");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes empty input object to invoke", async () => {
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
  });
});

// ── environment.get ───────────────────────────────────────────────────────────

describe("environment.get route", () => {
  const PATH = "/environment/get";

  it("happy path POST: returns 200 with environment", async () => {
    const invokeResult = {
      environment: {
        id: "env-1",
        name: "Production",
        slug: "production",
        isDefault: true,
      },
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { environmentId: "env-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'get_environment' and surface 'api'", async () => {
    await app.fetch(post(PATH, { environmentId: "env-1" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_environment");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes environmentId to invoke", async () => {
    await app.fetch(post(PATH, { environmentId: "env-abc" }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.environmentId).toBe("env-abc");
  });

  it("missing environmentId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── environment.update ────────────────────────────────────────────────────────

describe("environment.update route", () => {
  const PATH = "/environment/update";

  it("happy path POST: returns 200 with updated environment", async () => {
    const invokeResult = {
      environment: {
        id: "env-1",
        name: "Prod v2",
        slug: "prod-v2",
        isDefault: false,
      },
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      post(PATH, { environmentId: "env-1", name: "Prod v2" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'update_environment' and surface 'api'", async () => {
    await app.fetch(post(PATH, { environmentId: "env-1" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("update_environment");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes environmentId and optional fields to invoke", async () => {
    await app.fetch(
      post(PATH, { environmentId: "env-1", name: "Updated", isActive: false }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.environmentId).toBe("env-1");
    expect(body.name).toBe("Updated");
    expect(body.isActive).toBe(false);
  });

  it("missing environmentId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { name: "Updated" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── environment.delete ────────────────────────────────────────────────────────

describe("environment.delete route", () => {
  const PATH = "/environment/delete";

  it("happy path POST: returns 200 with ok", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });

    const res = await app.fetch(post(PATH, { environmentId: "env-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("calls invoke with 'delete_environment' and surface 'api'", async () => {
    await app.fetch(post(PATH, { environmentId: "env-1" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_environment");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("missing environmentId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── environment.set_default ───────────────────────────────────────────────────

describe("environment.set_default route", () => {
  const PATH = "/environment/set-default";

  it("happy path POST: returns 200", async () => {
    const invokeResult = {
      environment: {
        id: "env-1",
        name: "Production",
        slug: "production",
        isDefault: true,
      },
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { environmentId: "env-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'set_default_environment' and surface 'api'", async () => {
    await app.fetch(post(PATH, { environmentId: "env-2" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("set_default_environment");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("missing environmentId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── secret.key.upsert ─────────────────────────────────────────────────────────

describe("secret.key.upsert route", () => {
  const PATH = "/secret/key/upsert";

  it("happy path POST: returns 200 with key id", async () => {
    mocks.invoke.mockResolvedValue({ id: "sk-1" });

    const res = await app.fetch(post(PATH, { key: "DATABASE_URL" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "sk-1" });
  });

  it("calls invoke with 'upsert_secret_key' and surface 'api'", async () => {
    await app.fetch(post(PATH, { key: "API_TOKEN", sensitive: true }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("upsert_secret_key");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes key and optional fields to invoke", async () => {
    await app.fetch(
      post(PATH, {
        key: "STRIPE_SECRET",
        sensitive: true,
        memo: "Stripe API key",
        defaultValue: null,
      }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.key).toBe("STRIPE_SECRET");
    expect(body.sensitive).toBe(true);
    expect(body.memo).toBe("Stripe API key");
    expect(body.defaultValue).toBeNull();
  });

  it("missing key → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { sensitive: true }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── secret.key.list ───────────────────────────────────────────────────────────

describe("secret.key.list route", () => {
  const PATH = "/secret/key/list";

  it("happy path POST with empty body: returns 200 with keys", async () => {
    const invokeResult = { keys: [] };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'list_secret_keys' and surface 'api'", async () => {
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_secret_keys");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes empty input object to invoke", async () => {
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
  });
});

// ── secret.key.delete ─────────────────────────────────────────────────────────

describe("secret.key.delete route", () => {
  const PATH = "/secret/key/delete";

  it("happy path POST: returns 200 with ok", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });

    const res = await app.fetch(post(PATH, { keyId: "sk-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("calls invoke with 'delete_secret_key' and surface 'api'", async () => {
    await app.fetch(post(PATH, { keyId: "sk-2" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("delete_secret_key");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("missing keyId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── secret.value.set ──────────────────────────────────────────────────────────

describe("secret.value.set route", () => {
  const PATH = "/secret/value/set";
  const VALID_BODY = {
    keyId: "sk-1",
    environmentId: "env-1",
    value: "my-secret-value",
  };

  it("happy path POST: returns 200 with ok", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("calls invoke with 'set_secret_value' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("set_secret_value");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes keyId, environmentId, value to invoke", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.keyId).toBe("sk-1");
    expect(body.environmentId).toBe("env-1");
    expect(body.value).toBe("my-secret-value");
  });

  it("missing keyId → 400, invoke not called", async () => {
    const res = await app.fetch(
      post(PATH, { environmentId: "env-1", value: "v" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── secret.value.unset ────────────────────────────────────────────────────────

describe("secret.value.unset route", () => {
  const PATH = "/secret/value/unset";
  const VALID_BODY = { keyId: "sk-1", environmentId: "env-1" };

  it("happy path POST: returns 200 with ok", async () => {
    mocks.invoke.mockResolvedValue({ ok: true });

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("calls invoke with 'unset_secret_value' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("unset_secret_value");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("missing environmentId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, { keyId: "sk-1" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── secret.reveal ─────────────────────────────────────────────────────────────

describe("secret.reveal route", () => {
  const PATH = "/secret/reveal";

  it("happy path POST: returns 200 with revealed value", async () => {
    const invokeResult = {
      key: "DATABASE_URL",
      value: "postgres://...",
      source: "override",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { keyId: "sk-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'reveal_secret' and surface 'api'", async () => {
    await app.fetch(post(PATH, { keyId: "sk-1", environmentId: "env-1" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("reveal_secret");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes keyId and optional environmentId to invoke", async () => {
    await app.fetch(post(PATH, { keyId: "sk-2", environmentId: "env-2" }));
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.keyId).toBe("sk-2");
    expect(body.environmentId).toBe("env-2");
  });

  it("missing keyId → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── secret.export ─────────────────────────────────────────────────────────────

describe("secret.export route", () => {
  const PATH = "/secret/export";

  it("happy path POST with empty body: returns 200", async () => {
    const invokeResult = {
      env: [{ key: "DATABASE_URL", value: "postgres://..." }],
      dotenv: "DATABASE_URL=postgres://...\n",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'export_secrets' and surface 'api'", async () => {
    await app.fetch(post(PATH, {}));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("export_secrets");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes optional environmentId and keyIds to invoke", async () => {
    await app.fetch(
      post(PATH, { environmentId: "env-1", keyIds: ["sk-1", "sk-2"] }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.environmentId).toBe("env-1");
    expect(body.keyIds).toEqual(["sk-1", "sk-2"]);
  });
});

// ── secret.import_env ─────────────────────────────────────────────────────────

describe("secret.import_env route", () => {
  const PATH = "/secret/import-env";
  const VALID_BODY = {
    text: "DATABASE_URL=postgres://localhost/db\nAPI_KEY=secret123\n",
  };

  it("happy path POST: returns 200 with rows", async () => {
    const invokeResult = {
      rows: [
        { key: "DATABASE_URL", action: "upsert", existed: false },
        { key: "API_KEY", action: "upsert", existed: false },
      ],
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'import_env_secrets' and surface 'api'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("import_env_secrets");
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("passes text and optional commit flag to invoke", async () => {
    await app.fetch(
      post(PATH, { text: "KEY=value", commit: true, environmentId: "env-1" }),
    );
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.text).toBe("KEY=value");
    expect(body.commit).toBe(true);
    expect(body.environmentId).toBe("env-1");
  });

  it("missing text → 400, invoke not called", async () => {
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
