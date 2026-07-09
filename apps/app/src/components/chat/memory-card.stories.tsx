import type { Meta, StoryObj } from "@storybook/react-vite";
import { MemoryCard } from "./memory-card";

const meta = {
  title: "Chat/MemoryCard",
  component: MemoryCard,
} satisfies Meta<typeof MemoryCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Recalled memories cited by the graph node each is grounded in (FACT / RULE / OBSERVATION). */
export const GroundedRecall: Story = {
  args: {
    queryId: "qry_recall_01",
    memories: [
      {
        id: "mem_01",
        lesson:
          "Migration files live in packages/database/atlas/migrations/, never in apps/. Regenerate atlas.sum after adding one.",
        memoryClass: "RULE",
        memoryKind: "constraint",
        confidenceScore: 92,
        enforcementScore: 100,
        score: 0.91,
        nodeRef: "constraint-migrations-location",
        node: {
          id: "913d6df1-2a7c-4c1e-9d0b-2f8a1e6b4c22",
          label: "Constraint",
          displayName: "Atlas migration location",
          properties: { domain: "database", severity: "high" },
        },
      },
      {
        id: "mem_02",
        lesson:
          "Rickover directed Naval Reactors and drove the US nuclear-powered submarine program from 1949.",
        memoryClass: "FACT",
        memoryKind: "biographical",
        confidenceScore: 88,
        enforcementScore: null,
        score: 0.83,
        nodeRef: "person-rickover",
        node: {
          id: "n_7a2f",
          label: "Person",
          displayName: "Hyman G. Rickover",
          properties: { rank: "Admiral", role: "Director, Naval Reactors" },
        },
      },
    ],
  },
};

/** A single low-confidence observation with no resolved graph node — falls back to the raw ref link. */
export const UnresolvedObservation: Story = {
  args: {
    queryId: "qry_recall_02",
    memories: [
      {
        id: "mem_03",
        lesson:
          "The user prefers the narrowest possible test command — a single file or one package's test:unit, never the whole repo.",
        memoryClass: "OBSERVATION",
        memoryKind: "preference",
        confidenceScore: 54,
        enforcementScore: null,
        score: 0.61,
        nodeRef: "pref-narrow-tests",
      },
    ],
  },
};
