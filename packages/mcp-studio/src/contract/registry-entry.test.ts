// A registry catalog entry: the fields Oxagen reads are checked, and every
// other key the registry defines passes through.
import { describe, expect, it } from "vitest";
import { registryEntrySchema } from "./registry-entry";

const entry = {
  server: {
    name: "io.github.github/github-mcp-server",
    description: "Issues, pull requests, and code on GitHub.",
    version: "0.18.0",
    repository: { url: "https://github.com/github/github-mcp-server", source: "github" },
    remotes: [{ type: "streamable-http", url: "https://api.githubcopilot.com/mcp/", headers: [] }],
    packages: [
      {
        registryType: "oci",
        identifier: "ghcr.io/github/github-mcp-server",
        version: "0.18.0",
        transport: { type: "stdio", notes: "reads GITHUB_PERSONAL_ACCESS_TOKEN" },
        environmentVariables: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", isSecret: true }],
      },
    ],
  },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
};

/** The entry with `changes` set on its server and the `drop` keys taken off it. */
function withServer(changes: Record<string, unknown>, drop: readonly string[] = []): unknown {
  const server = Object.fromEntries(
    Object.entries({ ...entry.server, ...changes }).filter(([key]) => !drop.includes(key)),
  );
  return { ...entry, server };
}

describe("registryEntrySchema", () => {
  it("reads an entry and keeps the keys it does not check", () => {
    const parsed = registryEntrySchema.parse(entry);
    expect(parsed).toStrictEqual(entry);
    expect(parsed.server).toHaveProperty("repository.source", "github");
    expect(parsed.server.packages?.[0]).toHaveProperty("environmentVariables");
    expect(parsed.server.packages?.[0]?.transport).toHaveProperty("notes");
  });

  it("reads an entry with no remotes and no packages", () => {
    const { remotes: _remotes, packages: _packages, ...server } = entry.server;
    expect(registryEntrySchema.safeParse({ server }).success).toBe(true);
  });

  it("refuses a name with no namespace", () => {
    const parsed = registryEntrySchema.safeParse(withServer({ name: "github-mcp-server" }));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => [issue.path.join("."), issue.message])).toStrictEqual([
      ["server.name", "a registry name is <namespace>/<name>"],
    ]);
  });

  it("refuses a remote whose url is not http or https", () => {
    const remotes = [{ type: "streamable-http", url: "ftp://mcp.example.com" }];
    const parsed = registryEntrySchema.safeParse(withServer({ remotes }));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.every((issue) => issue.path.join(".") === "server.remotes.0.url")).toBe(true);
  });

  it("refuses a package with no transport", () => {
    const packages = [{ registryType: "npm", identifier: "@example/mcp" }];
    const parsed = registryEntrySchema.safeParse(withServer({ packages }));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join("."))).toStrictEqual(["server.packages.0.transport"]);
  });

  it("refuses an entry with no description or version", () => {
    for (const key of ["description", "version"]) {
      const parsed = registryEntrySchema.safeParse(withServer({}, [key]));
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      expect(parsed.error.issues.map((issue) => issue.path.join("."))).toStrictEqual([`server.${key}`]);
    }
  });
});
