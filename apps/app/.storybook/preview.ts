import "../src/app/globals.css";
import type { Preview } from "@storybook/react-vite";

// Storybook has no API backend. Flag the runtime so client data-services (e.g.
// the schema-builder's schema-service) serve in-memory fixtures instead of
// firing fetches to `/api/*` that 404 inside the preview iframe. Set before any
// story renders so the components' mount-time fetches see fixtures.
(globalThis as { __OXAGEN_STORYBOOK__?: boolean }).__OXAGEN_STORYBOOK__ = true;

const preview: Preview = {
  parameters: {
    layout: "padded",
    controls: { expanded: true },
  },
};

export default preview;
