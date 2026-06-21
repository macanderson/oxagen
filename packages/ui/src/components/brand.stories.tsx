import type { Meta, StoryObj } from "@storybook/react-vite";
import { OxagenLogo, OxagenLogomark, OxagenWordmark, BrandMark } from "./brand";

const meta = {
  title: "Brand/Logo",
  component: OxagenLogo,
} satisfies Meta<typeof OxagenLogo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <OxagenLogo variant="horizontal" size={32} />
      <OxagenLogo variant="vertical" size={48} />
      <div className="flex items-center gap-6">
        <OxagenLogomark className="size-10" />
        <OxagenWordmark className="text-2xl" />
        <BrandMark />
      </div>
    </div>
  ),
};
