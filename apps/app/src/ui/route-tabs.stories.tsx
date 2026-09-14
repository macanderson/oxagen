import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { RouteTabs } from "./route-tabs";

const meta = {
  title: "Mission Control/RouteTabs",
  component: RouteTabs,
  tags: ["autodocs"],
  args: {
    label: "Tools sections",
    current: "registry",
    tabs: [
      { id: "registry", href: "/acme/core-platform/tools", label: "Registry" },
      {
        id: "connections",
        href: "/acme/core-platform/tools/connections",
        label: "Connections",
      },
      {
        id: "mandates",
        href: "/acme/core-platform/tools/mandates",
        label: "Mandates",
        count: 2,
      },
      {
        id: "policy",
        href: "/acme/core-platform/tools/policy",
        label: "Policy",
      },
      {
        id: "switches",
        href: "/acme/core-platform/tools/switches",
        label: "Kill switches",
      },
      {
        id: "assurance",
        href: "/acme/core-platform/tools/assurance",
        label: "Assurance",
      },
    ],
  },
} satisfies Meta<typeof RouteTabs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultTab: Story = {};

export const DeepLinkedTab: Story = { args: { current: "mandates" } };

export const Phone: Story = { globals: { viewport: { value: "mobile1" } } };
