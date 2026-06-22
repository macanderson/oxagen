import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tabs, TabsList, TabsTab, TabsPanel, TabsIndicator } from "./tabs";

const meta = {
  title: "Navigation/Tabs",
  component: Tabs,
} satisfies Meta<typeof Tabs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="account" className="w-80">
      <TabsList>
        <TabsTab value="account">Account</TabsTab>
        <TabsTab value="password">Password</TabsTab>
        <TabsTab value="team">Team</TabsTab>
      </TabsList>
      <TabsPanel value="account">Manage your account settings.</TabsPanel>
      <TabsPanel value="password">Change your password here.</TabsPanel>
      <TabsPanel value="team">Invite and manage team members.</TabsPanel>
    </Tabs>
  ),
};

export const Underline: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-80">
      <TabsList variant="underline">
        <TabsTab value="overview">Overview</TabsTab>
        <TabsTab value="activity">Activity</TabsTab>
        <TabsTab value="settings">Settings</TabsTab>
        <TabsIndicator />
      </TabsList>
      <TabsPanel value="overview">Overview panel.</TabsPanel>
      <TabsPanel value="activity">Activity panel.</TabsPanel>
      <TabsPanel value="settings">Settings panel.</TabsPanel>
    </Tabs>
  ),
};
