import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { denied, notBacked, readError } from "@/data/not-backed";
import { PageState } from "./page-state";

const meta = {
  title: "Mission Control/PageState",
  component: PageState,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PageState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { page: "fleet", loading: true } };

export const LoadingDetail: Story = {
  args: { page: "run", loading: true, layout: "detail" },
};

export const Empty: Story = { args: { page: "fleet", empty: true } };

export const EmptyWithPageCopy: Story = {
  args: {
    page: "fleet",
    empty: true,
    title: "No runs yet",
    body: "Wrap an agent and its first run lands here.",
  },
};

export const ErrorState: Story = {
  name: "Error",
  args: { page: "tools", result: readError("tool_registry_unavailable", 503) },
};

export const Denied: Story = {
  args: { page: "audit", result: denied("org.auditor") },
};

export const NotRecordedYet: Story = {
  args: { page: "fleet", result: notBacked("M2", "G3") },
};

export const WaitingOnSpecDecision: Story = {
  args: { page: "tools", result: notBacked("spec-decision", "G12") },
};
