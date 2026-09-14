import "../src/app/globals.css";
import type { Preview } from "@storybook/react-vite";

// `next/link` (and other Next client modules) read `process.env.*` at module
// eval time — e.g. `has-base-path.js` touches `process.env.__NEXT_ROUTER_BASEPATH`.
// Next injects `process.env` via its compiler; Vite's browser runtime has no
// `process`, so those reads throw "process is not defined" and the story fails
// to render. Provide a minimal shim (reads resolve to `undefined`, never throw)
// before any story module — hence any Next module — is imported.
{
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  g.process = g.process ?? {};
  g.process.env = g.process.env ?? {};
}

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
