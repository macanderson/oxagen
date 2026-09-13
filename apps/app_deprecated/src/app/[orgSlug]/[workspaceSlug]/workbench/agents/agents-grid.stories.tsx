import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentsGrid, type AgentGridRow } from "./agents-grid";

const meta = {
  title: "Workbench/AgentsGrid",
  component: AgentsGrid,
} satisfies Meta<typeof AgentsGrid>;
export default meta;
type Story = StoryObj<typeof meta>;

function agent(
  overrides: Partial<AgentGridRow> & { slug: string },
): AgentGridRow {
  return {
    agentId: `id-${overrides.slug}`,
    publicId: `agt_${overrides.slug}`,
    agentKey: `macan2.default.${overrides.slug}`,
    name: overrides.slug,
    description: null,
    status: "draft",
    deploymentStatus: "inactive",
    latestVersion: 1,
    managed: false,
    avatarUrl: null,
    summary: null,
    roleName: "Agent Contributor",
    detailHref: `/acme/default/workbench/agents/agt_${overrides.slug}`,
    launchHref: null,
    ...overrides,
  };
}

/**
 * Every status × deployment combination. Regression surface for the
 * "Active Active" duplicate-badge bug: the live, deployed agent must read
 * "Active · Deployed", never two identical "Active" chips.
 */
export const AllStates: Story = {
  args: {
    agents: [
      agent({
        slug: "ds-drift-auditor",
        name: "DS Drift Auditor",
        summary: "Watches design-system tokens for drift and files tickets.",
        status: "active",
        deploymentStatus: "active",
        latestVersion: 4,
        launchHref: "/acme/default/sessions?agent=agt_ds-drift-auditor",
      }),
      agent({
        slug: "release-notes",
        name: "Release Notes Writer",
        summary: "Drafts release notes from merged PRs.",
        status: "active",
        deploymentStatus: "inactive",
        latestVersion: 2,
      }),
      agent({
        slug: "qa-helper",
        name: "QA Helper",
        description: "Manual QA checklist assistant.",
      }),
      agent({
        slug: "legacy-bot",
        name: "Legacy Onboarding Bot",
        status: "archived",
        deploymentStatus: "inactive",
        latestVersion: 9,
      }),
    ],
  },
};
