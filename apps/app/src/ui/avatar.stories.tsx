import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  AVATAR_ICONS,
  Avatar,
  type AvatarIconName,
  type AvatarTone,
} from "./avatar";

const meta = {
  title: "Mission Control/Avatar",
  component: Avatar,
  tags: ["autodocs"],
  args: {
    avatar: { kind: "initials", text: "MB", tone: "solid" },
    label: "Marcus Bell",
    size: 40,
  },
} satisfies Meta<typeof Avatar>;
export default meta;
type Story = StoryObj<typeof meta>;

const tones: AvatarTone[] = ["solid", "soft", "line"];

export const Initials: Story = {};

export const Matrix: Story = {
  name: "Initials, icon and photo × solid, soft and line",
  render: () => (
    <div className="flex flex-col gap-3">
      {tones.map((tone) => (
        <div key={tone} className="flex items-center gap-3">
          <Avatar
            avatar={{ kind: "initials", text: "PN", tone }}
            label={`Priya Nair, ${tone}`}
            size={36}
          />
          <Avatar
            avatar={{ kind: "initials", text: "OPS", font: "mono", tone }}
            size={36}
            label={`Ops, ${tone}`}
          />
          <Avatar
            avatar={{ kind: "icon", icon: "rocket", tone }}
            shape="agent"
            size={36}
            label={`Release manager, ${tone}`}
          />
        </div>
      ))}
      <Avatar
        avatar={{
          kind: "photo",
          src: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><rect width='1' height='1' fill='%23888'/></svg>",
        }}
        size={36}
        label="Dana Okafor"
      />
    </div>
  ),
};

export const AgentIcons: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(AVATAR_ICONS) as AvatarIconName[]).map((icon) => (
        <Avatar
          key={icon}
          avatar={{ kind: "icon", icon }}
          shape="agent"
          size={32}
          label={icon}
        />
      ))}
    </div>
  ),
};

export const Fallback: Story = {
  args: { avatar: null, label: "Unknown person" },
};
