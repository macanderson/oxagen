import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Money } from "./money";

const meta = {
  title: "Mission Control/Money",
  component: Money,
  tags: ["autodocs"],
  args: {
    value: { micros: "2450000000", currency: "USD", basis: "gateway_observed" },
  },
} satisfies Meta<typeof Money>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Inline: Story = {};

export const LargeWithBasisDialog: Story = {
  args: {
    variant: "large",
    value: { micros: "4131265", currency: "USD", basis: "client_attested" },
  },
};

export const Negative: Story = {
  args: { value: { micros: "-1500000", currency: "USD", basis: "mixed" } },
};

export const ExactMicros: Story = {
  args: {
    precision: "exact",
    value: { micros: "41265", currency: "USD", basis: "gateway_observed" },
  },
};

export const CompactEuro: Story = {
  args: {
    precision: "compact",
    value: { micros: "12450000000", currency: "EUR", basis: "estimated" },
  },
};

export const BasisNotRecorded: Story = {
  args: { variant: "large", value: { micros: "0", currency: "USD" } },
};
