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
    config.resolve.extensionAlias = {
      ".js": [".ts", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    // Prevent the dev watch loop: rspack emits its compiled output to
    // dist/ (and xmcp scaffolds .xmcp/), both of which sit inside the
    // watched project root. Without ignoring them, every emit re-fires
    // the watcher → recompile → emit → "Restarting http server" forever,
    // even when no source file has changed. Ignore build outputs and
    // node_modules so only real source edits trigger a rebuild.
    config.watchOptions = {
      ...(config.watchOptions ?? {}),
      ignored: ["**/dist/**", "**/.xmcp/**", "**/node_modules/**"],
    };
    return config;
  },
  typescript: {
    skipTypeCheck: true,
  },
};

export default config;
