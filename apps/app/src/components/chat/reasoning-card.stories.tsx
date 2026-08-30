import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReasoningCard } from "./reasoning-card";

const meta = {
  title: "Chat/ReasoningCard",
  component: ReasoningCard,
} satisfies Meta<typeof ReasoningCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Live thinking — expanded and streaming while the model reasons. */
export const Thinking: Story = {
  args: {
    status: "thinking",
    text: "The user wants the API route wired first. Let me confirm the contract exists in packages/oxagen/src/contracts before mounting it on the Hono app, then decide where the handler registration goes.",
  },
};

/** Finished reasoning — auto-collapses to a "Thought for Xs" summary that re-opens on click. */
export const Done: Story = {
  args: {
    status: "done",
    durationMs: 4200,
    text: "Confirmed the contract exists. The route mounts in apps/api/src/app.ts and the handler must import @oxagen/handlers/register before invoke() runs, otherwise metering silently no-ops.",
  },
};

/** Redacted reasoning — the provider emitted a reasoning boundary but no plaintext; shown as a pill only. */
export const Redacted: Story = {
  args: {
    status: "done",
    durationMs: 1800,
    text: "",
  },
};
