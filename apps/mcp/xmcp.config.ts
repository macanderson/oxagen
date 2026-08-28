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
  // rspack cannot resolve .js -> .ts for workspace packages that use
  // verbatimModuleSyntax / ESM relative imports with .js extensions in
  // TypeScript source. extensionAlias maps each .js import to its .ts
  // equivalent so rspack finds the TypeScript source.
  // See docs/specs/mcp/xmcp-migration-plan.md ("Risk 2").
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

    // Keep heavy packages out of the bundle to stay under the Vercel 250MB
    // serverless function size limit. These are either:
    //   - native-addon packages rspack cannot parse (dockerode -> ssh2)
    //   - large document/media libs loaded lazily via `await import()` in handlers
    //   - SDKs used only at runtime (inngest, ai, neo4j-driver)
    // They resolve from node_modules at runtime because the xmcp Vercel preset
    // runs `pnpm install` at the monorepo root alongside the function bundle.
    const heavyPackages = [
      // duckdb is a native CJS addon reached via `require("duckdb")` in
      // @oxagen/engram's graph-store, pulled into this build transitively:
      //   src/middleware.ts -> @oxagen/agent register/handlers
      //   -> agent.trace.get.ts -> @oxagen/engram barrel -> store/graph-store.ts.
      // Its node-pre-gyp/node-gyp toolchain ships non-JS assets rspack cannot
      // parse (C# Find-VisualStudio.cs, HTML, s3_setup.js) and dynamically
      // require()s aws-sdk/mock-aws-s3/nock. Externalize the whole chain so it
      // resolves from node_modules at runtime — mirrors the identical externals
      // already declared in apps/app/next.config.mjs.
      "duckdb",
      "@mapbox/node-pre-gyp",
      "node-gyp",
      "mock-aws-s3",
      "aws-sdk",
      "nock",
      "blake3",
      "dockerode",
      "exceljs",
      "pptxgenjs",
      "docx",
      "pdf-lib",
      "inngest",
      "@vercel/sandbox",
      "neo4j-driver",
      "ai",
      "drizzle-orm",
      "postgres",
      "@clickhouse/client",
      "stripe",
      "better-auth",
    ];

    // Function-based external: matches exact package names and sub-path imports
    // (e.g. `inngest/components/...`, `ai/rsc`). Careful with `ai` to avoid
    // false positives on unrelated packages that happen to start with "ai".
    const heavyExternalFn = (
      data: { request?: string },
      callback: (err?: Error, result?: string) => void,
    ) => {
      const request = data.request ?? "";
      const isHeavy = heavyPackages.some(
        (pkg) => request === pkg || request.startsWith(pkg + "/"),
      );
      if (isHeavy) {
        return callback(undefined, "commonjs " + request);
      }
      callback();
    };

    const existing = config.externals;
    config.externals = Array.isArray(existing)
      ? [...existing, heavyExternalFn]
      : existing
        ? [existing, heavyExternalFn]
        : [heavyExternalFn];

    return config;
  },
  typescript: {
    skipTypeCheck: true,
  },
};

export default config;
