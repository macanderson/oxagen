// How a credential is applied: the scheme schema's checks, and the scheme a
// non-OpenAPI auth.scheme means.
import { describe, expect, it } from "vitest";
import { builtinSecurityScheme, SECURITY_SCHEME_TYPES, securitySchemeSchema } from "./security-scheme";

/** Every issue zod reports for a scheme, with its path joined by dots. */
function issues(value: unknown): Array<{ path: string; message: string }> {
  const parsed = securitySchemeSchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

describe("builtinSecurityScheme", () => {
  const rows: Array<[Parameters<typeof builtinSecurityScheme>[0], string | undefined, unknown]> = [
    ["oauth", undefined, { type: "oauth2" }],
    ["bearer", undefined, { type: "http_bearer" }],
    ["basic", undefined, { type: "http_basic" }],
    ["header", "X-Api-Key", { type: "api_key", in: "header", name: "X-Api-Key" }],
  ];

  it.each(rows)("maps %s to a scheme the schema accepts", (scheme, header, expected) => {
    const resolved = builtinSecurityScheme(scheme, header);
    expect(resolved).toStrictEqual(expected);
    expect(issues(resolved)).toStrictEqual([]);
  });

  it("ignores a header for every scheme but header", () => {
    expect(builtinSecurityScheme("bearer", "X-Api-Key")).toStrictEqual({ type: "http_bearer" });
  });

  it("throws when scheme is header and no header is named", () => {
    expect(() => builtinSecurityScheme("header", undefined)).toThrow(
      new TypeError("auth.header is required when scheme is header"),
    );
  });
});

describe("securitySchemeSchema", () => {
  it("accepts every type in its plain form", () => {
    const valid: Record<(typeof SECURITY_SCHEME_TYPES)[number], unknown> = {
      oauth2: {
        type: "oauth2",
        authorization_url: "https://auth.example.com/authorize",
        token_url: "https://auth.example.com/token",
        refresh_url: "https://auth.example.com/refresh",
        scopes: ["invoices:read", "invoices:write"],
      },
      openIdConnect: {
        type: "openIdConnect",
        openid_connect_url: "https://auth.example.com/.well-known/openid-configuration",
      },
      http_bearer: { type: "http_bearer" },
      http_basic: { type: "http_basic" },
      api_key: { type: "api_key", in: "query", name: "api_key" },
      mutual_tls: { type: "mutual_tls" },
    };
    for (const type of SECURITY_SCHEME_TYPES) expect(issues(valid[type])).toStrictEqual([]);
  });

  it("asks an API key where it goes and what it is called", () => {
    expect(issues({ type: "api_key" })).toStrictEqual([
      { path: "in", message: "in is required when type is api_key" },
      { path: "name", message: "name is required when type is api_key" },
    ]);
  });

  it("refuses in and name on any other type", () => {
    expect(issues({ type: "http_bearer", in: "header" })).toStrictEqual([
      { path: "in", message: "in is not allowed when type is not api_key" },
    ]);
    expect(issues({ type: "oauth2", name: "Authorization" })).toStrictEqual([
      { path: "name", message: "name is not allowed when type is not api_key" },
    ]);
  });

  it("asks OpenID Connect for its discovery document", () => {
    expect(issues({ type: "openIdConnect" })).toStrictEqual([
      { path: "openid_connect_url", message: "openid_connect_url is required when type is openIdConnect" },
    ]);
  });

  it("refuses a scope listed twice", () => {
    expect(issues({ type: "oauth2", scopes: ["read", "read"] })).toStrictEqual([
      { path: "scopes.1", message: 'scopes lists "read" twice' },
    ]);
  });

  it("refuses an unknown type and an unknown key", () => {
    expect(issues({ type: "digest" })).toHaveLength(1);
    const unknownKey = issues({ type: "http_basic", realm: "billing" });
    expect(unknownKey).toHaveLength(1);
    expect(unknownKey[0]?.message).toContain("realm");
  });

  it("refuses an OAuth endpoint that is not an http URL", () => {
    expect(issues({ type: "oauth2", token_url: "ftp://auth.example.com/token" }).map((issue) => issue.path)).toContain(
      "token_url",
    );
  });
});
