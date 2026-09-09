import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// The model call is the whole subject: capture what the handler hands it.
type GenerateArgs = { abortSignal?: AbortSignal; prompt?: string };
const generateCalls: GenerateArgs[] = [];
vi.mock("@oxagen/ai", () => ({
  generateObjectFor: async (args: GenerateArgs) => {
    generateCalls.push(args);
    return {
      object: { assistantMessage: "Drafted.", schemas: [], mutations: [] },
    };
  },
  selectModel: () => "mock-model",
}));

// No draft yet, so loadDraft returns its empty text without touching a database.
vi.mock("./schema.versioning", () => ({
  getOrCreateRegistry: async () => ({ draftVersionId: null }),
}));
vi.mock("@oxagen/database", () => ({
  schema: {},
  withTenantDb: vi.fn(),
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaChatHandler, SCHEMA_CHAT_MODEL_TIMEOUT_MS } from "./schema.chat";

const ctx: CapabilityContext = {
  orgId: "9f71d7f8-2d9f-48aa-9117-8ce6f2df60ae",
  workspaceId: "6c7cf857-c073-47be-b625-ffcac9551884",
  userId: "b4f3f7ee-5f2a-4f2a-9d2b-0a6a5a7f1c11",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: "req-1",
  clientIp: null,
} as CapabilityContext;

// The proxies in front of the app (ALB idle_timeout, Caddy
// response_header_timeout) are set to 300 s. The handler has to give up
// first, or a slow model turn reaches the user as a bare proxy 504 while the
// server keeps working.
const PROXY_CEILING_MS = 300_000;

describe("schema.chat — the model call is bounded", () => {
  beforeEach(() => {
    generateCalls.length = 0;
  });

  it("hands the model call a timeout signal under the proxy ceiling", async () => {
    // A scaffold request: no deterministic fast path, so the model is called.
    await schemaChatHandler(
      { message: "generate schemas for a B2B SaaS company" },
      ctx,
    );
    expect(generateCalls).toHaveLength(1);
    const signal = generateCalls[0]?.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(SCHEMA_CHAT_MODEL_TIMEOUT_MS).toBeLessThan(PROXY_CEILING_MS);
  });
});
