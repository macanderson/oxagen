import type { StorybookConfig } from "@storybook/react-vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  // Stories for the chat capability render components (the generative-UI layer).
  stories: [
    "../src/components/chat/**/*.stories.@(ts|tsx)",
    "../src/components/knowledge/**/*.stories.@(ts|tsx)",
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
    return cfg;
  },
};

export default config;
