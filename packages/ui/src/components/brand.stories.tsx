import type { Meta, StoryObj } from "@storybook/react";
import {
  OxagenWordmark,
  OxagenIcon,
  StellaWordmark,
  StellaIcon,
  BrandMark,
} from "./brand";

/**
 * The house marks. Oxagen shows the WORDMARK — there is no lockup story
 * because there is no lockup: the icon appears alone, in square slots only.
 * Stella's asterisk lives inside its own word.
 */
const meta = {
  title: "Brand/Marks",
  component: OxagenWordmark,
} satisfies Meta<typeof OxagenWordmark>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Oxagen: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6 p-6">
      <OxagenWordmark className="h-10" />
      <OxagenWordmark className="h-10" tone="mono" />
      <div className="flex items-center gap-6">
        <OxagenIcon className="size-10" />
        <BrandMark />
      </div>
    </div>
  ),
};

export const Stella: Story = {
  render: () => (
    <div className="flex flex-col items-start gap-6 p-6">
      <StellaWordmark className="h-10" />
      <StellaWordmark className="h-10" tone="mono" />
      <StellaIcon className="size-10" />
    </div>
  ),
};
