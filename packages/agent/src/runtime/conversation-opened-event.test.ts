// conversation-opened-event.test.ts: the send a new conversation's first turn
// awaits is best-effort and bounded, so the event bus can never hold the turn.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_OPENED_SEND_TIMEOUT_MS,
  type ConversationOpenedEvent,
  sendConversationOpened,
  setConversationOpenedSender,
} from "./conversation-opened-event";

const event: ConversationOpenedEvent = {
  name: "chat/conversation.opened",
  data: {
    conversationId: "0192d4a8-7c1e-7a00-8000-0000000c0a01",
    orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
    workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  },
};

afterEach(() => {
  setConversationOpenedSender(null);
  vi.useRealTimers();
});

describe("sendConversationOpened", () => {
  it("sends the event keyed by conversation", async () => {
    const send = vi.fn(async () => undefined);
    setConversationOpenedSender(send);
    await sendConversationOpened(event);
    expect(send).toHaveBeenCalledWith({
      ...event,
      id: "chat/conversation.opened:0192d4a8-7c1e-7a00-8000-0000000c0a01",
    });
  });

  it("resolves when no sender is installed", async () => {
    await expect(sendConversationOpened(event)).resolves.toBeUndefined();
  });

  it("resolves when the send rejects", async () => {
    setConversationOpenedSender(async () => {
      throw new Error("bus refused");
    });
    await expect(sendConversationOpened(event)).resolves.toBeUndefined();
  });

  it("resolves when the sender throws before it returns a promise", async () => {
    setConversationOpenedSender(() => {
      throw new Error("sender broke");
    });
    await expect(sendConversationOpened(event)).resolves.toBeUndefined();
  });

  it("stops waiting on a stalled send once the limit passes", async () => {
    vi.useFakeTimers();
    // A send that never settles, as when the event bus stalls.
    setConversationOpenedSender(() => new Promise<void>(() => undefined));
    let settled = false;
    const pending = sendConversationOpened(event).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(CONVERSATION_OPENED_SEND_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
  });
});
