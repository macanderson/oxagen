// Storybook for the Mission Control primitives (plan §5 B1 L2). The Next.js
// Vite framework mocks next/link, next/navigation and next/image; the a11y
// addon runs axe on every story and fails it on a violation (preview.tsx).
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/nextjs-vite";
import { mergeConfig } from "vite";

const src = fileURLToPath(new URL("../src", import.meta.url));

const config: StorybookConfig = {
  framework: { name: "@storybook/nextjs-vite", options: {} },
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-a11y"],
  staticDirs: ["../public"],
  viteFinal: (viteConfig) =>
    mergeConfig(viteConfig, {
      resolve: {
        alias: { "@": src },
        // One React for the app and its workspace packages: @oxagen/ui pins
        // react 19.2.6 as a peer, and two copies break every hook.
        dedupe: ["react", "react-dom"],
      },
    }),
};

export default config;
