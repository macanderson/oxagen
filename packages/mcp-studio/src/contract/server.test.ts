// mcp-server/v1: every source type, every cross-field check, and the
// environment every agent's calls go to.
import { describe, expect, it } from "vitest";
import {
  agentEnvironment,
  DEFAULT_ENVIRONMENT,
  isDefinitionSource,
  mcpServerSchema,
  serverSourceSchema,
  type McpServer,
} from "./server";

interface Issue {
  path: string;
  message: string;
}

/** Every issue zod reports for a server.toml value, with its path joined by dots. */
function issues(value: unknown): Issue[] {
  const parsed = mcpServerSchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

// The spec's two example servers.
const stripe = {
  schema: "mcp-server/v1",
  name: "stripe",
  label: "Stripe",
  description: "Payments, refunds, and customers in Stripe.",
  source: { type: "remote", url: "https://mcp.stripe.com", transport: "http" },
  auth: { mode: "service", scheme: "oauth" },
  environments: {
    test: { sandbox: true, credential: "oxagen:credential/stripe-test" },
    live: { credential: "oxagen:credential/stripe-live" },
  },
  exposure: { mode: "direct", definition_budget: 8000 },
  sync: { schedule: "daily" },
};

const billing = {
  schema: "mcp-server/v1",
  name: "billing",
  label: "Billing",
  description: "A-Intel's billing service.",
  source: {
    type: "openapi",
    from: "repository",
    repo: "github.com/a-intel/billing-service",
    path: "openapi/billing.yaml",
    ref: "main",
  },
  auth: { mode: "operator-oauth", scheme: "oauth", credential: "oxagen:credential/billing-oauth-client" },
  environments: {
    sandbox: { sandbox: true, url: "https://billing-sandbox.a-intel.com/v2" },
    production: { url: "https://billing.internal.a-intel.com/v2", network: "relay:a-intel-east" },
  },
  exposure: { mode: "direct" },
  sync: { schedule: "on-change" },
};

const serviceAuth = { mode: "service", scheme: "bearer", credential: "oxagen:credential/api-token" };
const oneEnvironment = { production: { url: "https://api.example.com" } };

/** A server with the given source and auth, and whatever else the source needs. */
function server(source: Record<string, unknown>, rest: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "mcp-server/v1",
    name: "example",
    label: "Example",
    description: "An example server.",
    source,
    exposure: { mode: "search" },
    sync: { schedule: "manual" },
    ...rest,
  };
}

describe("valid servers", () => {
  it("reads the spec's stripe and billing servers", () => {
    expect(issues(stripe)).toStrictEqual([]);
    expect(issues(billing)).toStrictEqual([]);
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "a registry server",
      server(
        {
          type: "registry",
          registry: "https://registry.modelcontextprotocol.io",
          server: "io.github.github/github-mcp-server",
          version: "1.2.0",
        },
        { auth: { mode: "operator-oauth", scheme: "oauth", credential: "oxagen:credential/github-oauth" } },
      ),
    ],
    [
      "a local server",
      server({
        type: "local",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        env: ["HOME"],
        machines: ["dev-laptops"],
      }),
    ],
    [
      "an OpenAPI document from a URL",
      server(
        { type: "openapi", from: "url", url: "https://api.example.com/openapi.json" },
        { auth: serviceAuth, environments: oneEnvironment },
      ),
    ],
    [
      "an uploaded OpenAPI document with a scheme named by the document",
      server(
        { type: "openapi", from: "upload" },
        {
          auth: { mode: "service", scheme: "ApiKeyAuth", credential: "oxagen:credential/api-token" },
          environments: oneEnvironment,
        },
      ),
    ],
    [
      "a GraphQL schema read by introspection",
      server({ type: "graphql", from: "introspection" }, { auth: serviceAuth, environments: oneEnvironment }),
    ],
    [
      "a gRPC package read by reflection, with a header credential",
      server(
        { type: "grpc", from: "reflection", network: "relay:a-intel-east" },
        {
          auth: { mode: "service", scheme: "header", header: "x-api-key", credential: "oxagen:credential/ledger" },
          environments: oneEnvironment,
        },
      ),
    ],
    [
      "a remote server with no auth",
      server({ type: "remote", url: "https://mcp.example.com", transport: "sse" }, { auth: { mode: "none" } }),
    ],
  ];

  it.each(cases)("reads %s", (_label, value) => {
    expect(issues(value)).toStrictEqual([]);
  });
});

describe("sources", () => {
  const openapi = { type: "openapi", from: "repository", repo: "github.com/a/b", path: "openapi.yaml", ref: "main" };
  const rest = { auth: serviceAuth, environments: oneEnvironment };

  const cases: Array<[string, Record<string, unknown>, Issue]> = [
    [
      "a repository source with no ref",
      { ...openapi, ref: undefined },
      { path: "source.ref", message: "ref is required when from is repository" },
    ],
    [
      "a repository source with a url",
      { ...openapi, url: "https://example.com/openapi.yaml" },
      { path: "source.url", message: "url is not allowed when from is repository" },
    ],
    [
      "a url source with no url",
      { type: "openapi", from: "url" },
      { path: "source.url", message: "url is required when from is url" },
    ],
    [
      "a url source with a repo",
      { type: "openapi", from: "url", url: "https://example.com/openapi.yaml", repo: "github.com/a/b" },
      { path: "source.repo", message: "repo is not allowed when from is url" },
    ],
    [
      "an upload with a path",
      { type: "graphql", from: "upload", path: "schema.graphql" },
      { path: "source.path", message: "path is not allowed when from is upload" },
    ],
    [
      "introspection with a url",
      { type: "graphql", from: "introspection", url: "https://example.com/graphql" },
      { path: "source.url", message: "url is not allowed when from is introspection" },
    ],
    [
      "reflection with a repo",
      { type: "grpc", from: "reflection", repo: "github.com/a/b" },
      { path: "source.repo", message: "repo is not allowed when from is reflection" },
    ],
    [
      "a repository that is not on GitHub or GitLab",
      { ...openapi, repo: "bitbucket.org/a/b" },
      {
        path: "source.repo",
        message: "a repository is github.com/<owner>/<name> or gitlab.com/<group>/<name>",
      },
    ],
  ];

  it.each(cases)("refuses %s", (_label, source, issue) => {
    expect(issues(server(source, rest))).toContainEqual(issue);
  });

  it("refuses introspection for OpenAPI and reflection for GraphQL", () => {
    // The source union reports a from value its type does not allow as one issue on source.
    const refused = [{ path: "source", message: "Invalid input" }];
    expect(issues(server({ type: "openapi", from: "introspection" }, rest))).toStrictEqual(refused);
    expect(issues(server({ type: "graphql", from: "reflection" }, rest))).toStrictEqual(refused);
    expect(issues(server({ type: "graphql", from: "introspection" }, rest))).toStrictEqual([]);
    expect(issues(server({ type: "grpc", from: "reflection" }, rest))).toStrictEqual([]);
  });

  it("refuses a local env variable listed twice", () => {
    expect(issues(server({ type: "local", command: "files", env: ["HOME", "HOME"] }))).toContainEqual({
      path: "source.env.1",
      message: 'source.env lists "HOME" twice',
    });
  });

  it("refuses a registry name without a namespace", () => {
    const registry = {
      type: "registry",
      registry: "https://registry.modelcontextprotocol.io",
      server: "github-mcp-server",
      version: "1.2.0",
    };
    expect(issues(server(registry, { auth: { mode: "none" } }))).toStrictEqual([
      {
        path: "source.server",
        message: "a registry name is <namespace>/<name>, such as io.github.github/github-mcp-server",
      },
    ]);
    const namespaced = { ...registry, server: "io.github.github/github-mcp-server" };
    expect(issues(server(namespaced, { auth: { mode: "none" } }))).toStrictEqual([]);
  });

  it("tells a definition source from an MCP one", () => {
    const definitions = [
      openapi,
      { type: "graphql", from: "introspection" },
      { type: "grpc", from: "reflection" },
    ].map((source) => isDefinitionSource(serverSourceSchema.parse(source)));
    const mcp = [
      stripe.source,
      { type: "local", command: "files" },
      {
        type: "registry",
        registry: "https://registry.modelcontextprotocol.io",
        server: "io.github.github/github-mcp-server",
        version: "1.2.0",
      },
    ].map((source) => isDefinitionSource(serverSourceSchema.parse(source)));
    expect(definitions).toStrictEqual([true, true, true]);
    expect(mcp).toStrictEqual([false, false, false]);
  });
});

describe("auth", () => {
  const remote = { type: "remote", url: "https://mcp.example.com", transport: "http" };

  it("requires auth unless the source is local", () => {
    expect(issues(server(remote))).toStrictEqual([
      { path: "auth", message: 'auth is required unless the source is local. Write mode = "none" for none.' },
    ]);
  });

  it("refuses auth and environments for a local server", () => {
    const local = server({ type: "local", command: "files" }, { auth: { mode: "none" }, environments: oneEnvironment });
    expect(issues(local)).toStrictEqual([
      { path: "auth", message: "auth is not allowed for a local server, which gets no credential from Oxagen" },
      {
        path: "environments",
        message: "environments is not allowed for a local server, which gets no credential from Oxagen",
      },
    ]);
  });

  it("refuses a scheme, header, or credential when the mode is none", () => {
    const found = issues(
      server(remote, {
        auth: { mode: "none", scheme: "header", header: "x-api-key", credential: "oxagen:credential/x" },
      }),
    );
    expect(found).toContainEqual({ path: "auth.scheme", message: "scheme is not allowed when mode is none" });
    expect(found).toContainEqual({ path: "auth.header", message: "header is not allowed when mode is none" });
    expect(found).toContainEqual({ path: "auth.credential", message: "credential is not allowed when mode is none" });
  });

  it("requires a scheme when the mode is not none", () => {
    expect(
      issues(server(remote, { auth: { mode: "service", credential: "oxagen:credential/x" } })),
    ).toContainEqual({ path: "auth.scheme", message: "scheme is required when mode is not none" });
  });

  it("limits the scheme to oauth, bearer, basic, and header outside OpenAPI", () => {
    const apiKeyAuth = { mode: "service", scheme: "ApiKeyAuth", credential: "oxagen:credential/x" };
    const outsideOpenApi = [
      server(remote, { auth: apiKeyAuth }),
      server({ type: "graphql", from: "introspection" }, { auth: apiKeyAuth, environments: oneEnvironment }),
      server({ type: "grpc", from: "reflection" }, { auth: apiKeyAuth, environments: oneEnvironment }),
    ];
    for (const value of outsideOpenApi) {
      expect(issues(value)).toStrictEqual([
        { path: "auth.scheme", message: "auth.scheme is one of oauth, bearer, basic, header" },
      ]);
    }
  });

  it("refuses an environment's credential when the mode is none", () => {
    const value = server(remote, {
      auth: { mode: "none" },
      environments: { live: { credential: "oxagen:credential/x" }, test: { sandbox: true } },
    });
    expect(issues(value)).toStrictEqual([
      { path: "environments.live.credential", message: "credential is not allowed when auth.mode is none" },
    ]);
  });

  it("requires a header for the header scheme, and only for it", () => {
    expect(
      issues(server(remote, { auth: { mode: "service", scheme: "header", credential: "oxagen:credential/x" } })),
    ).toStrictEqual([{ path: "auth.header", message: "auth.header is required when scheme is header" }]);
    expect(
      issues(
        server(remote, {
          auth: { mode: "service", scheme: "bearer", header: "x-api-key", credential: "oxagen:credential/x" },
        }),
      ),
    ).toStrictEqual([{ path: "auth.header", message: "auth.header is allowed only when scheme is header" }]);
  });

  it("refuses a header for OpenAPI, whose security scheme names it", () => {
    const openapi = server(
      { type: "openapi", from: "upload" },
      {
        auth: { mode: "service", scheme: "ApiKeyAuth", header: "x-api-key", credential: "oxagen:credential/x" },
        environments: oneEnvironment,
      },
    );
    expect(issues(openapi)).toStrictEqual([
      {
        path: "auth.header",
        message: "auth.header is not allowed for OpenAPI, whose security scheme names the header",
      },
    ]);
  });

  it("requires a credential unless every environment names one", () => {
    const credentialMessage =
      "auth.credential is required unless the mode is none or every environment names a credential";
    expect(issues(server(remote, { auth: { mode: "service", scheme: "bearer" } }))).toStrictEqual([
      { path: "auth.credential", message: credentialMessage },
    ]);
    const liveHasNone = { ...stripe, environments: { ...stripe.environments, live: {} } };
    expect(issues(liveHasNone)).toStrictEqual([{ path: "auth.credential", message: credentialMessage }]);
  });
});

describe("environments", () => {
  it("requires an environment for a server built from a definition", () => {
    const { environments: _environments, ...noEnvironments } = billing;
    expect(issues(noEnvironments)).toStrictEqual([
      {
        path: "environments",
        message: "a server built from a definition needs at least one environment with its url",
      },
    ]);
  });

  it("requires an environment for a GraphQL or gRPC server read live", () => {
    const live = [
      server({ type: "graphql", from: "introspection" }, { auth: serviceAuth }),
      server({ type: "grpc", from: "reflection" }, { auth: serviceAuth }),
    ];
    for (const value of live) {
      expect(issues(value)).toStrictEqual([
        {
          path: "environments",
          message: "a server built from a definition needs at least one environment with its url",
        },
      ]);
    }
  });

  it("requires each environment of a definition server to name its url", () => {
    const noUrl = { ...billing, environments: { ...billing.environments, production: { network: "cloud" } } };
    expect(issues(noUrl)).toStrictEqual([
      {
        path: "environments.production.url",
        message: "url is required: a server built from a definition takes its endpoint from the environment",
      },
    ]);
  });

  it("needs no sandbox mark with one environment", () => {
    const single = { ...stripe, environments: { live: stripe.environments.live } };
    expect(issues(single)).toStrictEqual([]);
  });

  it("requires a sandbox when a server has two or more environments", () => {
    const unmarked = {
      ...stripe,
      environments: { ...stripe.environments, test: { credential: "oxagen:credential/stripe-test" } },
    };
    expect(issues(unmarked)).toStrictEqual([
      {
        path: "environments",
        message:
          "mark one environment sandbox = true: every agent's calls go to the sandbox when a server has two or more environments",
      },
    ]);
  });

  it("counts sandbox = false as no mark", () => {
    const falseMark = {
      ...stripe,
      environments: {
        test: { sandbox: false, credential: "oxagen:credential/stripe-test" },
        live: { sandbox: false, credential: "oxagen:credential/stripe-live" },
      },
    };
    expect(issues(falseMark).map((issue) => issue.path)).toStrictEqual(["environments"]);
  });

  it("refuses a second sandbox and names the first", () => {
    const twoSandboxes = {
      ...stripe,
      environments: { ...stripe.environments, live: { sandbox: true, credential: "oxagen:credential/stripe-live" } },
    };
    expect(issues(twoSandboxes)).toStrictEqual([
      { path: "environments.live.sandbox", message: "only one environment may be the sandbox, and test already is" },
    ]);
  });

  it("refuses an environment name that is not snake_case", () => {
    const badName = { ...stripe, environments: { Live: { credential: "oxagen:credential/stripe-live" } } };
    expect(issues(badName)).toStrictEqual([
      {
        path: "environments.Live",
        message: "an environment name starts with a letter and has at most 32 lowercase letters, digits, and underscores",
      },
    ]);
  });
});

describe("the rest of the file", () => {
  it("refuses the reserved server name builtin", () => {
    expect(issues({ ...stripe, name: "builtin" })).toContainEqual({
      path: "name",
      message: "builtin is reserved for Oxagen's built-in tools",
    });
  });

  it("refuses a key the schema does not name", () => {
    const found = issues({ ...stripe, owner: "payments" });
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("owner");
  });

  it("refuses a definition budget below one token", () => {
    expect(issues({ ...stripe, exposure: { mode: "direct", definition_budget: 0 } })).toStrictEqual([
      { path: "exposure.definition_budget", message: "Number must be greater than or equal to 1" },
    ]);
    expect(issues({ ...stripe, exposure: { mode: "direct", definition_budget: 1 } })).toStrictEqual([]);
  });
});

describe("agentEnvironment", () => {
  it("is default for a server with no [environments] table", () => {
    const { environments: _environments, ...rest } = stripe;
    const noEnvironments = { ...rest, auth: { ...stripe.auth, credential: "oxagen:credential/stripe-live" } };
    expect(agentEnvironment(mcpServerSchema.parse(noEnvironments))).toBe(DEFAULT_ENVIRONMENT);
    expect(DEFAULT_ENVIRONMENT).toBe("default");
  });

  it("is the only environment when there is one", () => {
    const single = { ...stripe, environments: { live: stripe.environments.live } };
    expect(agentEnvironment(mcpServerSchema.parse(single))).toBe("live");
  });

  it("is the sandbox when there are two or more", () => {
    expect(agentEnvironment(mcpServerSchema.parse(stripe))).toBe("test");
    expect(agentEnvironment(mcpServerSchema.parse(billing))).toBe("sandbox");
  });

  it("throws for two environments with no sandbox, which the schema refuses", () => {
    const unmarked: Pick<McpServer, "environments"> = { environments: { live: {}, test: {} } };
    expect(() => agentEnvironment(unmarked)).toThrow(
      new TypeError("a server with two or more environments marks one sandbox = true"),
    );
  });
});
