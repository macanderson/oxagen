import type { XmcpConfig } from "xmcp";

const config: XmcpConfig = {
  http: {
    port: Number(process.env.MCP_PORT ?? 4100),
  },
  stdio: {
    silent: true,
  },
  // Disable unused feature directories to prevent xmcp from erroring on
  // missing paths. Tools live in src/tools/ (the default).
  paths: {
    prompts: false,
    resources: false,
  },
  // Risk 2 mitigation: rspack cannot resolve .js → .ts for workspace
  // packages that use verbatimModuleSyntax / ESM relative imports with
  // .js extensions in TypeScript source. extensionAlias maps each .js
  // import to its .ts equivalent so rspack finds the TypeScript source.
  bundler: (config) => {
    config.resolve = config.resolve ?? {};

    // xmcp force-aliases `zod` (and `zod/v3`, `zod/v4-mini`) to this app's
    // local zod (v3). better-auth depends on zod v4 and its dist imports
    // v4-only APIs (z.looseObject), so the forced alias breaks the build.
    // Remove the alias and let each package resolve its own zod version.
    if (config.resolve.alias && typeof config.resolve.alias === "object") {
      const alias = config.resolve.alias as Record<string, unknown>;
      delete alias["zod"];
      delete alias["zod/v3"];
      delete alias["zod/v4-mini"];
    }

    config.resolve.extensionAlias = {
      ".js": [".ts", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };

    // Keep `dockerode` (→ docker-modem → ssh2, which ships native .node files
    // rspack can't parse) out of the bundle. It reaches here via @oxagen/sandbox
    // (imported by the agent handlers), but the docker sandbox driver never runs
    // in the deployed MCP server — SANDBOX_DRIVER is vercel/modal in prod — and
    // createDockerSandbox loads dockerode lazily, so this external is never
    // resolved at runtime. Merge with any externals xmcp already configured.
    const dockerExternal = { dockerode: "commonjs dockerode" };
    const existing = config.externals;
    config.externals = Array.isArray(existing)
      ? [...existing, dockerExternal]
      : existing
        ? [existing, dockerExternal]
        : [dockerExternal];

    return config;
  },
  typescript: {
    skipTypeCheck: true,
  },
};

export default config;
