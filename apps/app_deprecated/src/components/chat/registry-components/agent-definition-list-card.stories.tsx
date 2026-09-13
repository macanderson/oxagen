import type { Meta, StoryObj } from "@storybook/react-vite";
import AgentDefinitionListCard from "./agent-definition-list-card";

const meta = {
  title: "Chat/AgentDefinitionListCard",
  component: AgentDefinitionListCard,
} satisfies Meta<typeof AgentDefinitionListCard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A populated roster from agent.definition.list — active, draft, archived, and a managed built-in. */
export const Populated: Story = {
  args: {
    capability: "agent.definition.list",
    orgSlug: "acme",
    workspaceSlug: "platform",
    output: {
      agents: [
        {
          publicId: "agt_support_triage",
          name: "Support Triage",
          slug: "support-triage",
          latestVersion: 7,
          deploymentStatus: "active",
          status: "active",
          managed: false,
        },
        {
          publicId: "agt_release_notes",
          name: "Release Notes Writer",
          slug: "release-notes-writer",
          latestVersion: 2,
          deploymentStatus: "inactive",
          status: "draft",
          managed: false,
        },
        {
          publicId: "agt_legacy_bot",
          name: "Legacy Onboarding Bot",
          slug: "legacy-onboarding-bot",
          latestVersion: 5,
          deploymentStatus: "inactive",
          status: "archived",
          managed: false,
        },
        {
          publicId: "agt_oxagen_assistant",
          name: "Oxagen Assistant",
          slug: "oxagen-assistant",
          latestVersion: 12,
          deploymentStatus: "active",
          status: "active",
          managed: true,
        },
      ],
    },
  },
};

/** No agents in the workspace — the empty state. */
export const Empty: Story = {
  args: {
    capability: "agent.definition.list",
    orgSlug: "acme",
    workspaceSlug: "platform",
    output: { agents: [] },
  },
};
