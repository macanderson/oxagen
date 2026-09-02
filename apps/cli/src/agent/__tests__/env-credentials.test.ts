/**
 * AI credential resolution — proves the BYOK precedence contract:
 * AI_GATEWAY_API_KEY always wins; ANTHROPIC_API_KEY is the fallback (and
 * installs the direct-Anthropic global provider); neither → null. All
 * filesystem/config sources are isolated so a real key on this machine never
 * leaks into the assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import type { ProviderV4 } from "@ai-sdk/provider";

const config: { gatewayKey?: string; anthropicKey?: string } = {};
vi.mock("../../lib/config.js", () => ({ readConfig: () => config }));

import {
  ensureGatewayKey,
  ensureAnthropicKey,
  resolveAiCredential,
  credentialSupportsModel,
} from "../env.js";
import { uninstallDirectAnthropicProviderForTests } from "../anthropic-direct.js";

// tmpdir(): no .env.local anywhere up the walk on CI or dev machines.
const cwd = tmpdir();

function globalProvider(): ProviderV4 | undefined {
  return (globalThis as { AI_SDK_DEFAULT_PROVIDER?: ProviderV4 })
    .AI_SDK_DEFAULT_PROVIDER;
}

beforeEach(() => {
  delete process.env["AI_GATEWAY_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];
  delete config.gatewayKey;
  delete config.anthropicKey;
  uninstallDirectAnthropicProviderForTests();
});

afterEach(() => {
  delete process.env["AI_GATEWAY_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];
  uninstallDirectAnthropicProviderForTests();
});

describe("resolveAiCredential", () => {
  it("returns null when neither key resolves anywhere", () => {
    expect(resolveAiCredential(cwd)).toBeNull();
    expect(globalProvider()).toBeUndefined();
  });

  it("prefers the gateway key when both are set", () => {
    process.env["AI_GATEWAY_API_KEY"] = "vck_1";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-1";
    expect(resolveAiCredential(cwd)).toEqual({
      source: "gateway",
      key: "vck_1",
    });
    // Gateway path must NOT hijack string-model resolution.
    expect(globalProvider()).toBeUndefined();
  });

  it("falls back to ANTHROPIC_API_KEY and installs the direct provider", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-1";
    expect(resolveAiCredential(cwd)).toEqual({
      source: "anthropic",
      key: "sk-ant-1",
    });
    expect(globalProvider()).toBeDefined();
  });

  it("resolves the anthropic key from config and pins it into process.env", () => {
    config.anthropicKey = "sk-ant-cfg";
    expect(resolveAiCredential(cwd)).toEqual({
      source: "anthropic",
      key: "sk-ant-cfg",
    });
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-cfg");
  });

  it("still resolves the gateway key from config first", () => {
    config.gatewayKey = "vck_cfg";
    config.anthropicKey = "sk-ant-cfg";
    expect(resolveAiCredential(cwd)).toEqual({
      source: "gateway",
      key: "vck_cfg",
    });
    expect(process.env["AI_GATEWAY_API_KEY"]).toBe("vck_cfg");
  });
});

describe("ensureGatewayKey / ensureAnthropicKey", () => {
  it("each resolves only its own variable", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-1";
    expect(ensureGatewayKey(cwd)).toBeNull();
    expect(ensureAnthropicKey(cwd)).toBe("sk-ant-1");
  });
});

describe("credentialSupportsModel", () => {
  it("gateway credentials run any vendor", () => {
    const cred = { source: "gateway" as const, key: "vck_1" };
    expect(credentialSupportsModel(cred, "openai/gpt-5.5-pro")).toBe(true);
    expect(credentialSupportsModel(cred, "anthropic/claude-sonnet-5")).toBe(
      true,
    );
  });

  it("anthropic credentials run only anthropic/* or bare slugs", () => {
    const cred = { source: "anthropic" as const, key: "sk-ant-1" };
    expect(credentialSupportsModel(cred, "anthropic/claude-sonnet-5")).toBe(
      true,
    );
    expect(credentialSupportsModel(cred, "claude-sonnet-5")).toBe(true);
    expect(credentialSupportsModel(cred, "openai/gpt-5.5-pro")).toBe(false);
    expect(credentialSupportsModel(cred, "google/gemini-3-pro")).toBe(false);
  });
});
