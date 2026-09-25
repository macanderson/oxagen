// Loading the handler registrations hands @oxagen/agent the event client, so
// an in-app assistant run's seal sends `cost/run.sealed` the way every other
// seal does (#4167). The agent package cannot import the client itself:
// @oxagen/inngest-functions depends on it.
import {
  type RunSealedEvent,
  sendRunSealed,
} from "@oxagen/agent/runtime/run-sealed-event";
import { describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({
  send: vi.fn(async () => undefined),
}));
vi.mock("./event-client", () => ({ eventClient: { send } }));

await import("./register");

describe("the handler registrations", () => {
  it("send an assistant run's seal event through the event client", async () => {
    const event: RunSealedEvent = {
      name: "cost/run.sealed",
      data: {
        runId: "arun_0123456789abcdef012345",
        orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
        workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
      },
    };
    await sendRunSealed(event);
    expect(send).toHaveBeenCalledWith(event);
  });
});
