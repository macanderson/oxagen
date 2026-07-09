import type { Meta, StoryObj } from "@storybook/react-vite";
import { BackgroundTaskCard } from "./background-task-card";

const meta = {
  title: "Chat/BackgroundTaskCard",
  component: BackgroundTaskCard,
} satisfies Meta<typeof BackgroundTaskCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A long-running ingestion job mid-flight — the progress bar only shows while running. */
export const Running: Story = {
  args: {
    taskId: "bgt_ingest_01",
    kind: "connection.sync",
    label: "Syncing Slack workspace",
    status: "running",
    inngestRunId: "run_01HZX8Q",
    progressPct: 62,
  },
};

/** Queued task waiting for a worker slot. */
export const Pending: Story = {
  args: {
    taskId: "bgt_embed_02",
    kind: "graph.embed.backfill",
    label: "Backfilling node embeddings",
    status: "pending",
  },
};

/** Terminal success — falls back to the kind when no label is given. */
export const Completed: Story = {
  args: {
    taskId: "bgt_reconcile_03",
    kind: "schema.reconcile.dispatch",
    status: "completed",
    inngestRunId: "run_01HZY2M",
  },
};

/** Terminal failure surface. */
export const Failed: Story = {
  args: {
    taskId: "bgt_export_04",
    kind: "eval.dataset.export",
    label: "Exporting eval dataset",
    status: "failed",
  },
};
