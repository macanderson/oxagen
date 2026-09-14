import type { Meta, StoryObj } from "@storybook/react-vite";
import ConversationListCard from "./conversation-list-card";

const meta = {
  title: "Chat/ConversationListCard",
  component: ConversationListCard,
  args: { orgSlug: "acme", workspaceSlug: "research" },
} satisfies Meta<typeof ConversationListCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {
  args: {
    output: {
      conversations: [
        {
          publicId: "c_1",
          title: "USS Nautilus research",
          status: "active",
          archivedAt: null,
          updatedAt: "2026-06-18T12:00:00Z",
        },
        {
          publicId: "c_2",
          title: "Reactor inventors",
          status: "active",
          archivedAt: null,
          updatedAt: "2026-06-17T09:30:00Z",
        },
        {
          publicId: "c_3",
          title: "",
          status: "active",
          archivedAt: "2026-06-10T00:00:00Z",
          updatedAt: "2026-06-10T00:00:00Z",
        },
      ],
      nextCursor: null,
    },
  },
};

export const Empty: Story = {
  args: { output: { conversations: [], nextCursor: null } },
};
