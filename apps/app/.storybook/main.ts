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

/**
 * Vite plugin that stubs `"use server"` modules for the browser bundle.
 *
 * Client components frequently import Server Actions directly (e.g. the schema
 * builder imports `schemaReconcileDispatchAction` from `reconcile-actions.ts`).
 * Next.js's RSC compiler rewrites those imports into thin network references,
 * so the server module's body — and its server-only deps (`@oxagen/handlers`,
 * `@clickhouse/client`, `neo4j-driver`, …) — never reach the browser. Plain
 * Vite has no such transform, so the whole server graph gets pulled into the
 * preview bundle and explodes (e.g. "@clickhouse/client does not provide an
 * export named 'createClient'").
 *
 * This mirrors Next's behaviour: for any module whose first statement is a
 * `"use server"` directive, replace the body with stub async functions named
 * after its exports. Every server action in the tree is `export async function`
 * (type/interface exports are erased by the compiler), so the exported binding
 * shape is preserved while none of the server code is bundled. The stubs reject
 * if invoked — Storybook has no backend — but stories never call them on render.
 */
const stubUseServerActions = {
  name: "oxagen-stub-use-server",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    const file = id.split("?")[0] ?? id;
    if (!/\.[cm]?tsx?$/.test(file) || !file.includes("/src/")) return null;
    // Leading BOM, comments, and whitespace may precede the directive.
    const directive =
      /^﻿?\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']\s*;?/;
    if (!directive.test(code)) return null;
    const names = new Set<string>();
    const re = /export\s+async\s+function\s+([A-Za-z0-9_$]+)/g;
    for (let m = re.exec(code); m; m = re.exec(code)) {
      if (m[1]) names.add(m[1]);
    }
    const stubs = [...names]
      .map(
        (n) =>
          `export async function ${n}() { throw new Error(` +
          `"[storybook] server action '${n}' is unavailable — Storybook has no backend"); }`,
      )
      .join("\n");
    return { code: stubs || "export {};", map: null };
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
    // Stub `"use server"` modules before any other transform so their
    // server-only import graph never enters the browser bundle.
    cfg.plugins = [stubUseServerActions, ...(cfg.plugins ?? [])];

    cfg.resolve = cfg.resolve ?? {};
    cfg.resolve.alias = {
      ...(cfg.resolve.alias ?? {}),
      // Mirror the app's tsconfig "@/*" -> "src/*" path alias.
      "@": resolve(root, "../src"),
    };

    // Force the automatic JSX runtime for every file esbuild transpiles.
    //
    // The app's tsconfig sets `"jsx": "preserve"` because Next.js manages its
    // own JSX transform (SWC, automatic runtime) — so ~114 components across
    // chat/knowledge/sandbox never `import React`. esbuild has no "preserve"
    // mode, so it silently falls back to the CLASSIC transform
    // (`React.createElement`), which needs `React` in scope and throws
    // "React is not defined" at runtime. Pinning esbuild to the automatic
    // runtime (`react/jsx-runtime`) mirrors Next's compilation and removes the
    // `React` dependency entirely, matching how the components run in prod.
    cfg.esbuild = {
      ...(typeof cfg.esbuild === "object" && cfg.esbuild ? cfg.esbuild : {}),
      jsx: "automatic",
      jsxImportSource: "react",
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
