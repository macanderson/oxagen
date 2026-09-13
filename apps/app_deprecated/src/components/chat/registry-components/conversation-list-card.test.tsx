// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ConversationListCard from "./conversation-list-card";

afterEach(cleanup);

describe("ConversationListCard", () => {
  it("renders conversations deep-linked to their chat pages", () => {
    render(
      <ConversationListCard
        output={{
          conversations: [
            {
              publicId: "c_1",
              title: "USS Nautilus research",
              status: "active",
              archivedAt: null,
              updatedAt: "2026-06-18T00:00:00Z",
            },
            {
              publicId: "c_2",
              title: "",
              status: "active",
              archivedAt: "2026-06-10T00:00:00Z",
              updatedAt: "2026-06-10T00:00:00Z",
            },
          ],
          nextCursor: null,
        }}
        orgSlug="acme"
        workspaceSlug="ws"
      />,
    );
    expect(screen.getByText("2 conversations")).toBeTruthy();
    const link = screen.getByText("USS Nautilus research").closest("a");
    expect(link?.getAttribute("href")).toBe("/acme/ws/chat/c_1");
    // empty title falls back
    expect(screen.getByText("Untitled conversation")).toBeTruthy();
    // archived indicator present
    expect(screen.getByLabelText("Archived")).toBeTruthy();
  });

  it("renders an empty state", () => {
    render(
      <ConversationListCard output={{ conversations: [], nextCursor: null }} />,
    );
    expect(screen.getByText("No conversations.")).toBeTruthy();
  });
});
