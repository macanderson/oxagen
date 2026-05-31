import type { XmcpConfig } from "xmcp";

const config: XmcpConfig = {
  http: {
    port: Number(process.env.MCP_PORT ?? 4100),
  },
  stdio: {
    silent: true,
  },
  // Disable unused feature directories to prevent xmcp from erroring on
  // missing paths. Tools were deleted in OXA-1416 (dead MCP tools purge);
  // capabilities are now exposed via the capability registry, not hand-listed.
  paths: {
    tools: false,
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
    return config;
  },
  typescript: {
    skipTypeCheck: true,
  },
};

export default config;
