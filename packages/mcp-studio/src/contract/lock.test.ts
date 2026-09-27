// mcp-tools-lock/v1 sources: a lock source follows server.toml's rules for
// where a definition comes from, so a lock is never looser than the file
// it pins.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { formatJson } from "./json";
import { definitionLockSourceSchema, localLockSourceSchema, mcpLockSourceSchema } from "./lock";
import { parseLock } from "./parse";

interface Issue {
  path: string;
  message: string;
}

/** Every issue zod reports for a value, with its path joined by dots. */
function issues(schema: z.ZodTypeAny, value: unknown): Issue[] {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

const hash = `sha256:${"a".repeat(64)}`;
const commit = "4be91d2c0a7e5f3b9d18e6a2c4f0b7d95e3a1c86";

/** A definition lock source with the given fields and a document hash. */
function source(fields: Record<string, unknown>): Record<string, unknown> {
  return { document_hash: hash, ...fields };
}

const repository = {
  type: "openapi",
  from: "repository",
  repo: "github.com/a-intel/billing-service",
  path: "openapi/billing.yaml",
  ref: "main",
  commit,
};

describe("definition lock source location", () => {
  it("accepts each place a definition comes from", () => {
    const accepted = [
      repository,
      { type: "openapi", from: "url", url: "https://billing.a-intel.com/openapi.yaml" },
      { type: "openapi", from: "upload" },
      { type: "graphql", from: "introspection" },
      { type: "grpc", from: "reflection" },
    ];
    for (const fields of accepted) expect(issues(definitionLockSourceSchema, source(fields))).toStrictEqual([]);
  });

  it("requires the url when the definition came from a url", () => {
    expect(issues(definitionLockSourceSchema, source({ type: "openapi", from: "url" }))).toStrictEqual([
      { path: "url", message: "url is required when from is url" },
    ]);
  });

  it("requires the repository fields and the commit when it came from a repository", () => {
    expect(issues(definitionLockSourceSchema, source({ type: "openapi", from: "repository" }))).toStrictEqual([
      { path: "repo", message: "repo is required when from is repository" },
      { path: "path", message: "path is required when from is repository" },
      { path: "ref", message: "ref is required when from is repository" },
      { path: "commit", message: "commit is required when from is repository" },
    ]);
  });

  it("refuses a url on a repository source and a repository on a url source", () => {
    expect(
      issues(definitionLockSourceSchema, source({ ...repository, url: "https://billing.a-intel.com/openapi.yaml" })),
    ).toStrictEqual([{ path: "url", message: "url is not allowed when from is repository" }]);
    const url = { type: "openapi", from: "url", url: "https://billing.a-intel.com/openapi.yaml" };
    expect(issues(definitionLockSourceSchema, source({ ...url, repo: repository.repo }))).toStrictEqual([
      { path: "repo", message: "repo is not allowed when from is url" },
    ]);
  });

  it("refuses a repository, a commit, or a url on an upload or a live read", () => {
    const upload = { type: "openapi", from: "upload", repo: repository.repo };
    expect(issues(definitionLockSourceSchema, source(upload))).toStrictEqual([
      { path: "repo", message: "repo is not allowed when from is upload" },
    ]);
    expect(issues(definitionLockSourceSchema, source({ type: "grpc", from: "upload", commit }))).toStrictEqual([
      { path: "commit", message: "commit is not allowed when from is upload" },
    ]);
    const introspection = { type: "graphql", from: "introspection", url: "https://api.a-intel.com/graphql" };
    expect(issues(definitionLockSourceSchema, source(introspection))).toStrictEqual([
      { path: "url", message: "url is not allowed when from is introspection" },
    ]);
  });
});

describe("definition lock source type", () => {
  it("refuses a from the type cannot come from", () => {
    const refused: Array<[string, string, string]> = [
      ["openapi", "introspection", "an OpenAPI definition comes from one of repository, url, upload"],
      ["openapi", "reflection", "an OpenAPI definition comes from one of repository, url, upload"],
      ["graphql", "reflection", "a GraphQL definition comes from one of repository, url, upload, introspection"],
      ["grpc", "introspection", "a gRPC definition comes from one of repository, url, upload, reflection"],
    ];
    for (const [type, from, message] of refused) {
      expect(issues(definitionLockSourceSchema, source({ type, from }))).toStrictEqual([{ path: "from", message }]);
    }
  });

  it("keeps security schemes to OpenAPI", () => {
    const schemes = { bearer: { type: "http_bearer" } };
    expect(
      issues(definitionLockSourceSchema, source({ type: "openapi", from: "upload", security_schemes: schemes })),
    ).toStrictEqual([]);
    for (const type of ["graphql", "grpc"]) {
      expect(
        issues(definitionLockSourceSchema, source({ type, from: "upload", security_schemes: schemes })),
      ).toStrictEqual([{ path: "security_schemes", message: `security_schemes is not allowed when type is ${type}` }]);
    }
  });

  it("reports a bad source through parseLock with the field path", () => {
    const text = readFileSync(new URL("../../fixtures/servers/billing/tools.lock.json", import.meta.url), "utf8");
    const lock = JSON.parse(text) as { source: Record<string, unknown> };
    expect(parseLock(text).ok).toBe(true);
    expect(parseLock(formatJson({ ...lock, source: { ...lock.source, from: "upload" } }))).toStrictEqual({
      ok: false,
      issues: [
        { line: null, field: "source.repo", message: "repo is not allowed when from is upload" },
        { line: null, field: "source.path", message: "path is not allowed when from is upload" },
        { line: null, field: "source.ref", message: "ref is not allowed when from is upload" },
        { line: null, field: "source.commit", message: "commit is not allowed when from is upload" },
      ],
    });
  });
});

describe("MCP lock sources", () => {
  const pinnedPackage = { name: "@modelcontextprotocol/server-filesystem", version: "2026.9.1", digest: hash };
  const registry = {
    type: "registry",
    registry: "https://registry.modelcontextprotocol.io",
    server: "io.github.github/github-mcp-server",
    version: "1.2.0",
  };

  it("accepts a registry entry that names its endpoint or its package", () => {
    expect(issues(mcpLockSourceSchema, { ...registry, url: "https://api.githubcopilot.com/mcp/" })).toStrictEqual([]);
    expect(issues(mcpLockSourceSchema, { ...registry, package: pinnedPackage })).toStrictEqual([]);
  });

  // Pinned as it stands: the contract does not yet require exactly one of url
  // and package on a registry source. PR #4416 lists this as a follow-up.
  it("accepts a registry entry with neither or both of url and package", () => {
    expect(issues(mcpLockSourceSchema, registry)).toStrictEqual([]);
    expect(
      issues(mcpLockSourceSchema, { ...registry, url: "https://api.githubcopilot.com/mcp/", package: pinnedPackage }),
    ).toStrictEqual([]);
  });

  it("requires a local server's pinned package", () => {
    const local = { type: "local", command: "npx @modelcontextprotocol/server-filesystem" };
    const pinned = { ...local, package: pinnedPackage, server_version: "0.6.2" };
    expect(issues(mcpLockSourceSchema, pinned)).toStrictEqual([]);
    expect(issues(localLockSourceSchema, local)).toStrictEqual([{ path: "package", message: "Required" }]);
    expect(
      issues(localLockSourceSchema, { ...local, package: { ...pinnedPackage, digest: "sha256:zz" } }),
    ).toStrictEqual([{ path: "package.digest", message: "Invalid" }]);
  });
});
