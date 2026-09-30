import type { XmcpConfig } from "xmcp";

/** A test or a `_` helper under src/tools, by relative or absolute request. */
const NOT_A_TOOL = /(?:^|[\\/])src[\\/]tools[\\/](?:[^\\/]+[\\/])*(?:_[^\\/]*|[^\\/]+\.test)\.tsx?$/;

/** xmcp's prebuilt server runtimes that register tools. */
const XMCP_RUNTIME_SERVER = /[\\/]xmcp[\\/]dist[\\/]runtime[\\/](?:http|adapter-express)\.js$/;

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
  bundler: (config) => {
    config.resolve = config.resolve ?? {};
    // mcp serves through xmcp's own HTTP entry. The owned edge in
    // src/http-app.ts stays unwired until a test drives a real request through
    // it with the real middleware (#4202).

    // One bundle, with each module once. xmcp gives every tool its own async
    // chunk and turns splitChunks off, so each of ~360 chunks carried its own
    // copy of the shared dependency graph: 1,266 files and 2.6 GB. The first
    // request imports every tool, and on 2026-09-30 that ran a 640 MB heap out
    // within 10 seconds, under the owned edge and xmcp's server alike (#4829).
    config.output = { ...config.output, asyncChunks: false };

    // Hand the MCP SDK each tool's raw input shape. xmcp wraps it in a zod v4
    // object around Oxagen's zod v3 fields, and tools/list failed on every
    // tool (#4829). xmcp-raw-input-shape.cjs says why and fails the build when
    // the pinned runtime no longer matches.
    config.module = config.module ?? {};
    config.module.rules = [
      ...(config.module.rules ?? []),
      {
        test: XMCP_RUNTIME_SERVER,
        loader: `${process.cwd()}/xmcp-raw-input-shape.cjs`,
      },
    ];

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
    // serverless function size limit. These fall into three groups:
    //   - a large lib loaded lazily via `await import()` in a handler
    //     (pdf-lib, for `export_conversation`'s PDF rendering path)
    //   - SDKs used only at runtime (inngest, ai, neo4j-driver, stripe,
    //     better-auth)
    //   - store clients reached only from inside handlers (drizzle-orm,
    //     postgres, @clickhouse/client)
    //
    // Every name below is also declared in this app's package.json even though
    // no file under src/ imports it. That is deliberate and load-bearing: an
    // externalized module is `require()`d from node_modules at runtime, and
    // pnpm's strict layout only exposes packages this app declares. Adding an
    // entry here without the matching dependency yields a runtime MODULE_NOT_FOUND
    // that no build step catches.
    //
    // ADR-043 (runtime excision) removed the sandbox/document-generation
    // capability families — @vercel/sandbox, dockerode, exceljs, pptxgenjs
    // and docx are no longer pulled in by anything under apps/mcp and were
    // dropped from this list and from package.json.
    const heavyPackages = [
      // duckdb and its node-pre-gyp chain left this list with @oxagen/engram
      // (ADR-144): nothing this app imports reaches them any more.
      "pdf-lib",
      "inngest",
      "neo4j-driver",
      "ai",
      "drizzle-orm",
      "postgres",
      "@clickhouse/client",
      "stripe",
      "better-auth",
      // Cedar's evaluator (the served tools, lane M15). The served tools
      // import its Node build by a literal name, and that build reads its
      // .wasm file from its own directory, so the package stays on disk.
      "@cedar-policy/cedar-wasm",
      // The relay broker's WebSocket server (lane M12, ADR-225). ws requires
      // its optional native helpers, `bufferutil` and `utf-8-validate`, inside
      // try/catch, so the bundler must not try to resolve them. ws loads
      // without them.
      "ws",
    ];

    // Function-based external: matches exact package names and sub-path imports
    // (e.g. `inngest/components/...`, `ai/rsc`). Careful with `ai` to avoid
    // false positives on unrelated packages that happen to start with "ai".
    const heavyExternalFn = (
      data: { request?: string },
      callback: (err?: Error, result?: string) => void,
    ) => {
      const request = data.request ?? "";
      // xmcp registers every file under src/tools as a tool, the tests and
      // `_` helpers too. Each resolves to an empty module, which xmcp skips,
      // so production never imports vitest.
      if (NOT_A_TOOL.test(request)) {
        return callback(undefined, "var {}");
      }
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
