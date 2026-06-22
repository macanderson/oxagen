import type { StorybookConfig } from "@storybook/react-vite";

/**
 * Storybook for @oxagen/ui — the coss ui (Base UI) component system.
 *
 * Runs the components straight from `src` (this package has no build step;
 * apps consume the raw TS via `transpilePackages`). Tailwind v4 + the design
 * tokens are processed through `postcss.config.mjs` (the `@tailwindcss/postcss`
 * plugin), and the token-driven `globals.css` is imported once in `preview.tsx`.
 */
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: { name: "@storybook/react-vite", options: {} },
  core: { disableTelemetry: true },
};

export default config;
