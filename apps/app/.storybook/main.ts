import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

/** Node.js built-in modules that server-only transitive deps import. */
const nodeBuiltins = [
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
];

/**
 * esbuild plugin that marks Node.js built-in imports as external so the
 * dep-optimizer never tries to resolve them in the browser bundle.
 */
const externalizeNodeBuiltins = {
  name: "externalize-node-builtins",
  setup(build: {
    onResolve: (
      opts: { filter: RegExp },
      cb: (args: { path: string }) => { path: string; external: boolean },
    ) => void;
  }) {
    const filter = new RegExp(`^(node:)?(${nodeBuiltins.join("|")})$`);
    build.onResolve({ filter }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const config: StorybookConfig = {
  // Stories for the chat capability render components (the generative-UI layer).
  stories: [
    "../src/components/chat/**/*.stories.@(ts|tsx)",
    "../src/components/knowledge/**/*.stories.@(ts|tsx)",
    "../src/components/sandbox/**/*.stories.@(ts|tsx)",
  ],
  framework: { name: "@storybook/react-vite", options: {} },
  core: { disableTelemetry: true },
  viteFinal: async (cfg) => {
    cfg.resolve = cfg.resolve ?? {};
    cfg.resolve.alias = {
      ...(cfg.resolve.alias ?? {}),
      // Mirror the app's tsconfig "@/*" -> "src/*" path alias.
      "@": resolve(root, "../src"),
    };

    // The app transitively depends on server-only packages (ClickHouse,
    // nodemailer, neo4j-driver, @vercel/blob, etc.) that import Node.js
    // built-ins. Exclude them from Vite's dependency pre-bundling entirely.
    cfg.optimizeDeps = cfg.optimizeDeps ?? {};
    cfg.optimizeDeps.exclude = [
      ...(cfg.optimizeDeps.exclude ?? []),
      "@clickhouse/client",
      "nodemailer",
      "agent-base",
      "neo4j-driver",
      "postgres",
      "@vercel/blob",
      "@neondatabase/serverless",
      "better-auth",
      "stripe",
      "inngest",
    ];

    // Attach the esbuild plugin to externalize Node built-ins during
    // dependency optimization (handles any deps not excluded above).
    cfg.optimizeDeps.esbuildOptions = cfg.optimizeDeps.esbuildOptions ?? {};
    cfg.optimizeDeps.esbuildOptions.plugins = [
      ...(cfg.optimizeDeps.esbuildOptions.plugins ?? []),
      externalizeNodeBuiltins,
    ];

    // Also tell Rollup (production bundle) to externalize node builtins.
    const externals: string[] = nodeBuiltins.flatMap((m) => [m, `node:${m}`]);
    cfg.build = cfg.build ?? {};
    cfg.build.rollupOptions = cfg.build.rollupOptions ?? {};
    const existing = cfg.build.rollupOptions.external;
    if (typeof existing === "function") {
      cfg.build.rollupOptions.external = (source, importer, isResolved) => {
        if (externals.includes(source)) return true;
        return existing(source, importer, isResolved);
      };
    } else {
      cfg.build.rollupOptions.external = [
        ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
        ...externals,
      ];
    }

    return cfg;
  },
};

export default config;
