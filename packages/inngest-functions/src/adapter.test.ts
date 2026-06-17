import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventClient } from "@oxagen/functions";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue({ ids: ["test-id-1"] }),
}));

vi.mock("./inngest", () => ({
  inngest: { send: mocks.send },
}));

// Import after mocks are set up
const { createEventClient, NonRetriableError } = await import("./adapter");

describe("adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createEventClient", () => {
    it("returns an object satisfying EventClient", () => {
      const client = createEventClient();
      expect(client).toBeDefined();
      expect(typeof client.send).toBe("function");

      // Type-level assertion: client is assignable to EventClient
      const _typed: EventClient = client;
      expect(_typed).toBe(client);
    });

    it("delegates send() with a single event to inngest.send()", async () => {
      const client = createEventClient();
      const event = { name: "test/event", data: { foo: "bar" } };

      await client.send(event);

      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(mocks.send).toHaveBeenCalledWith(event);
    });

    it("delegates send() with an array of events to inngest.send()", async () => {
      const client = createEventClient();
      const events = [
        { name: "test/event.one", data: { a: 1 } },
        { name: "test/event.two", data: { b: 2 } },
      ];

      await client.send(events);

      expect(mocks.send).toHaveBeenCalledTimes(1);
      expect(mocks.send).toHaveBeenCalledWith(events);
    });

    it("returns Promise<void> regardless of inngest.send() return", async () => {
      const client = createEventClient();
      const result = await client.send({ name: "test/event", data: {} });

      // EventClient.send() returns void, not { ids: string[] }
      expect(result).toBeUndefined();
    });

    it("propagates errors from inngest.send()", async () => {
      mocks.send.mockRejectedValueOnce(new Error("network failure"));
      const client = createEventClient();
      await expect(
        client.send({ name: "test/event", data: {} }),
      ).rejects.toThrow("network failure");
    });
  });

  describe("NonRetriableError", () => {
    it("is re-exported from @oxagen/functions", () => {
      const error = new NonRetriableError("test failure");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(NonRetriableError);
      expect(error.message).toBe("test failure");
      expect(error.name).toBe("NonRetriableError");
    });

    it("has isNonRetriable property set to true", () => {
      const error = new NonRetriableError("permanent");
      expect(error.isNonRetriable).toBe(true);
    });

    it("supports cause option", () => {
      const cause = new Error("root cause");
      const error = new NonRetriableError("wrapped", { cause });
      expect(error.cause).toBe(cause);
    });
  });
});
