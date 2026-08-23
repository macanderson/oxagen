/**
 * AI credential resolution, .env.local walk included — proves the full
 * resolve order (process.env → config → nearest .env.local walking up),
 * the parse rules for a .env.local hit (comments, missing `=`, foreign
 * keys, quoted values, first match wins even when empty), that a config
 * or file hit is pinned into process.env, and the gateway-first fallback
 * contract. Config and the direct-Anthropic install are mocked so no real
 * key on this machine leaks into the assertions.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config: { gatewayKey?: string; anthropicKey?: string } = {};
vi.mock("../lib/config.js", () => ({ readConfig: () => config }));

const installMock = vi.fn();
vi.mock("./anthropic-direct.js", () => ({
  installDirectAnthropicProvider: (key: string) => installMock(key),
}));

import {
  ensureGatewayKey,
  ensureAnthropicKey,
  resolveAiCredential,
  credentialSupportsModel,
  MissingAiKeyError,
} from "./env.js";

// tmpdir(): no .env.local anywhere up the walk on CI or dev machines.
const bareCwd = tmpdir();

function tempTree(): string {
  return mkdtempSync(join(tmpdir(), "oxagen-env-test-"));
}

beforeEach(() => {
  delete process.env["AI_GATEWAY_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];
  delete config.gatewayKey;
  delete config.anthropicKey;
});

describe("resolve order: process.env → config → .env.local", () => {
  it("returns the process.env value untouched when already set", () => {
    process.env["AI_GATEWAY_API_KEY"] = "vck_env";
    config.gatewayKey = "vck_cfg";
    expect(ensureGatewayKey(bareCwd)).toBe("vck_env");
    expect(process.env["AI_GATEWAY_API_KEY"]).toBe("vck_env");
  });

  it("treats an empty env var as unset and falls through to config", () => {
    process.env["AI_GATEWAY_API_KEY"] = "";
    config.gatewayKey = "vck_cfg";
    expect(ensureGatewayKey(bareCwd)).toBe("vck_cfg");
    expect(process.env["AI_GATEWAY_API_KEY"]).toBe("vck_cfg");
  });

  it("prefers config over a .env.local that also defines the key", () => {
    const cwd = tempTree();
    writeFileSync(join(cwd, ".env.local"), "AI_GATEWAY_API_KEY=vck_file\n");
    config.gatewayKey = "vck_cfg";
    expect(ensureGatewayKey(cwd)).toBe("vck_cfg");
  });

  it("pins a .env.local hit into process.env", () => {
    const cwd = tempTree();
    writeFileSync(join(cwd, ".env.local"), "ANTHROPIC_API_KEY=sk-ant-file\n");
    expect(ensureAnthropicKey(cwd)).toBe("sk-ant-file");
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-file");
  });

  it("returns null when no source anywhere defines the key", () => {
    expect(ensureGatewayKey(bareCwd)).toBeNull();
    expect(ensureAnthropicKey(bareCwd)).toBeNull();
    expect(process.env["AI_GATEWAY_API_KEY"]).toBeUndefined();
  });
});

describe(".env.local walk and parse", () => {
  it("finds the key in the nearest ancestor when cwd itself has no .env.local", () => {
    const root = tempTree();
    writeFileSync(join(root, ".env.local"), "AI_GATEWAY_API_KEY=vck_up\n");
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(ensureGatewayKey(nested)).toBe("vck_up");
  });

  it("the nearest file wins over one further up", () => {
    const root = tempTree();
    writeFileSync(join(root, ".env.local"), "AI_GATEWAY_API_KEY=vck_far\n");
    const nested = join(root, "sub");
    mkdirSync(nested);
    writeFileSync(join(nested, ".env.local"), "AI_GATEWAY_API_KEY=vck_near\n");
    expect(ensureGatewayKey(nested)).toBe("vck_near");
  });

  it("skips comments, blanks, lines without `=`, and foreign keys", () => {
    const cwd = tempTree();
    writeFileSync(
      join(cwd, ".env.local"),
      [
        "# a comment",
        "",
        "not-an-assignment",
        "OTHER_KEY=nope",
        "  AI_GATEWAY_API_KEY = vck_ok  ",
      ].join("\n"),
    );
    expect(ensureGatewayKey(cwd)).toBe("vck_ok");
  });

  it("strips surrounding quotes but keeps `=` inside the value", () => {
    const dq = tempTree();
    writeFileSync(join(dq, ".env.local"), 'AI_GATEWAY_API_KEY="vck_a=b"\n');
    expect(ensureGatewayKey(dq)).toBe("vck_a=b");

    delete process.env["AI_GATEWAY_API_KEY"];
    const sq = tempTree();
    writeFileSync(join(sq, ".env.local"), "AI_GATEWAY_API_KEY='vck_sq'\n");
    expect(ensureGatewayKey(sq)).toBe("vck_sq");
  });

  it("an empty value in the nearest file resolves to null — the walk does not continue past a match", () => {
    const root = tempTree();
    writeFileSync(join(root, ".env.local"), "AI_GATEWAY_API_KEY=vck_far\n");
    const nested = join(root, "sub");
    mkdirSync(nested);
    writeFileSync(join(nested, ".env.local"), "AI_GATEWAY_API_KEY=\n");
    expect(ensureGatewayKey(nested)).toBeNull();
  });

  it("keeps walking past a .env.local that defines only foreign keys", () => {
    const root = tempTree();
    writeFileSync(join(root, ".env.local"), "AI_GATEWAY_API_KEY=vck_up\n");
    const nested = join(root, "sub");
    mkdirSync(nested);
    writeFileSync(join(nested, ".env.local"), "OTHER_KEY=nope\n");
    expect(ensureGatewayKey(nested)).toBe("vck_up");
  });

  it("keeps walking past an unreadable .env.local", () => {
    const root = tempTree();
    writeFileSync(join(root, ".env.local"), "AI_GATEWAY_API_KEY=vck_up\n");
    const nested = join(root, "sub");
    mkdirSync(nested);
    // A directory named .env.local: existsSync says yes, readFileSync throws.
    mkdirSync(join(nested, ".env.local"));
    expect(ensureGatewayKey(nested)).toBe("vck_up");
  });
});

describe("resolveAiCredential", () => {
  it("gateway always wins, and the direct provider is NOT installed", () => {
    process.env["AI_GATEWAY_API_KEY"] = "vck_1";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-1";
    expect(resolveAiCredential(bareCwd)).toEqual({ source: "gateway", key: "vck_1" });
    expect(installMock).not.toHaveBeenCalled();
  });

  it("falls back to the Anthropic key and installs the direct provider with it", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-1";
    expect(resolveAiCredential(bareCwd)).toEqual({
      source: "anthropic",
      key: "sk-ant-1",
    });
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(installMock).toHaveBeenCalledWith("sk-ant-1");
  });

  it("resolves the fallback from config and pins it into process.env", () => {
    config.anthropicKey = "sk-ant-cfg";
    expect(resolveAiCredential(bareCwd)).toEqual({
      source: "anthropic",
      key: "sk-ant-cfg",
    });
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-cfg");
  });

  it("returns null and installs nothing when neither key resolves", () => {
    expect(resolveAiCredential(bareCwd)).toBeNull();
    expect(installMock).not.toHaveBeenCalled();
  });
});

describe("credentialSupportsModel", () => {
  it("gateway credentials run any vendor", () => {
    const cred = { source: "gateway" as const, key: "vck_1" };
    expect(credentialSupportsModel(cred, "openai/gpt-5.5-pro")).toBe(true);
    expect(credentialSupportsModel(cred, "anthropic/claude-sonnet-5")).toBe(true);
  });

  it("anthropic credentials run only anthropic/* or bare slugs", () => {
    const cred = { source: "anthropic" as const, key: "sk-ant-1" };
    expect(credentialSupportsModel(cred, "anthropic/claude-sonnet-5")).toBe(true);
    expect(credentialSupportsModel(cred, "claude-sonnet-5")).toBe(true);
    expect(credentialSupportsModel(cred, "openai/gpt-5.5-pro")).toBe(false);
  });
});

describe("MissingAiKeyError", () => {
  it("names itself and points at every resolution source", () => {
    const err = new MissingAiKeyError();
    expect(err.name).toBe("MissingAiKeyError");
    expect(err.message).toContain("AI_GATEWAY_API_KEY");
    expect(err.message).toContain("ANTHROPIC_API_KEY");
    expect(err.message).toContain(".env.local");
  });
});
