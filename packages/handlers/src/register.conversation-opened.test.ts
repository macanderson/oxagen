import {
  type ConversationOpenedEvent,
  sendConversationOpened,
} from "@oxagen/agent/runtime/conversation-opened-event";
import { describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn(async () => undefined) }));
vi.mock("./event-client", () => ({ eventClient: { send } }));

await import("./register");

describe("the handler registrations", () => {
  it("send a new conversation's opened event through the event client", async () => {
    const event: ConversationOpenedEvent = {
      name: "chat/conversation.opened",
      data: {
        conversationId: "0192d4a8-7c1e-7a00-8000-0000000c0a01",
        orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
        workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
      },
    };
    await sendConversationOpened(event);
    expect(send).toHaveBeenCalledWith(event);
  });
});
