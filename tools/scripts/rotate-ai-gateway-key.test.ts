import { describe, expect, it } from "vitest";
import {
  extractGatewayKey,
  maskSecret,
  parseTokensFile,
  resolveTeam,
  tokenForSlug,
  upsertGatewayKey,
} from "./lib/rotate-ai-gateway-key";

describe("parseTokensFile", () => {
  it("accepts a bare array", () => {
    const entries = parseTokensFile('[{"slug":"oxagen","token":"tok_a"}]');
    expect(entries).toEqual([{ slug: "oxagen", token: "tok_a" }]);
  });

  it("accepts a { tokens: [...] } wrapper", () => {
    const entries = parseTokensFile(
      '{"tokens":[{"slug":"manderson","token":"tok_b"},{"slug":"oxagen","token":"tok_c"}]}',
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ slug: "oxagen", token: "tok_c" });
  });

  it("rejects invalid JSON", () => {
    expect(() => parseTokensFile("{nope")).toThrow(/not valid JSON/);
  });

  it("rejects non-array shapes", () => {
    expect(() => parseTokensFile('{"tokens":"x"}')).toThrow(/must be an array/);
  });

  it("rejects entries missing slug or token", () => {
    expect(() => parseTokensFile('[{"token":"t"}]')).toThrow(
      /missing a non-empty "slug"/,
    );
    expect(() => parseTokensFile('[{"slug":"oxagen","token":""}]')).toThrow(
      /"oxagen".*missing a non-empty "token"/,
    );
  });
});

describe("tokenForSlug", () => {
  const entries = [
    { slug: "manderson", token: "tok_m" },
    { slug: "oxagen", token: "tok_o" },
  ];

  it("returns the matching entry", () => {
    expect(tokenForSlug(entries, "oxagen").token).toBe("tok_o");
  });

  it("throws listing known slugs when absent", () => {
    expect(() => tokenForSlug(entries, "acme")).toThrow(
      /"manderson", "oxagen"/,
    );
  });
});

describe("upsertGatewayKey", () => {
  it("replaces an existing assignment in place", () => {
    const input = "FOO=1\nAI_GATEWAY_API_KEY=vck_old\nBAR=2\n";
    const { content, action } = upsertGatewayKey(input, "vck_new");
    expect(action).toBe("replaced");
    expect(content).toBe("FOO=1\nAI_GATEWAY_API_KEY=vck_new\nBAR=2\n");
  });

  it("replaces every live assignment but leaves comments untouched", () => {
    const input =
      "# AI_GATEWAY_API_KEY=vck_commented\nAI_GATEWAY_API_KEY=vck_a\nAI_GATEWAY_API_KEY=vck_b\n";
    const { content } = upsertGatewayKey(input, "vck_new");
    expect(content).toBe(
      "# AI_GATEWAY_API_KEY=vck_commented\nAI_GATEWAY_API_KEY=vck_new\nAI_GATEWAY_API_KEY=vck_new\n",
    );
  });

  it("does not rewrite keys that merely end with the name", () => {
    const input = "MY_AI_GATEWAY_API_KEY=other\n";
    const { content, action } = upsertGatewayKey(input, "vck_new");
    expect(action).toBe("appended");
    expect(content).toBe(
      "MY_AI_GATEWAY_API_KEY=other\nAI_GATEWAY_API_KEY=vck_new\n",
    );
  });

  it("appends to an empty file", () => {
    const { content, action } = upsertGatewayKey("", "vck_new");
    expect(action).toBe("appended");
    expect(content).toBe("AI_GATEWAY_API_KEY=vck_new\n");
  });

  it("appends after content lacking a trailing newline", () => {
    const { content } = upsertGatewayKey("FOO=1", "vck_new");
    expect(content).toBe("FOO=1\nAI_GATEWAY_API_KEY=vck_new\n");
  });
});

describe("extractGatewayKey", () => {
  it("prefers well-known field names", () => {
    expect(extractGatewayKey({ key: "vck_direct", note: "vck_decoy" })).toBe(
      "vck_direct",
    );
  });

  it("finds a nested key under an envelope object", () => {
    expect(
      extractGatewayKey({ apiKey: { id: "ak_1", token: "vck_nested" } }),
    ).toBe("vck_nested");
  });

  it("falls back to a recursive vck_ scan", () => {
    expect(
      extractGatewayKey({ data: { items: [{ opaque: "vck_found" }] } }),
    ).toBe("vck_found");
  });

  it("returns null when no key material is present", () => {
    expect(extractGatewayKey({ id: "ak_1", name: "my-key" })).toBeNull();
    expect(extractGatewayKey(null)).toBeNull();
  });
});

describe("resolveTeam", () => {
  it("resolves a slug to its team id", () => {
    const teams = {
      teams: [
        { id: "team_1", slug: "manderson" },
        { id: "team_2", slug: "oxagen" },
      ],
    };
    expect(resolveTeam(teams, "oxagen")).toEqual({
      id: "team_2",
      slug: "oxagen",
    });
  });

  it("throws with accessible slugs when the token cannot see the team", () => {
    const teams = { teams: [{ id: "team_1", slug: "manderson" }] };
    expect(() => resolveTeam(teams, "oxagen")).toThrow(
      /accessible teams: manderson/,
    );
  });

  it("handles a malformed response", () => {
    expect(() => resolveTeam({}, "oxagen")).toThrow(
      /accessible teams: \(none\)/,
    );
  });
});

describe("maskSecret", () => {
  it("shows only a short prefix and the length", () => {
    const masked = maskSecret("vck_1234567890abcdef");
    expect(masked).toBe("vck_1234… (20 chars)");
    expect(masked).not.toContain("90abcdef");
  });
});
