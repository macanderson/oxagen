// The refusal each work library error becomes (P1-03, #5103).
import { describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { TriageCorrectionError } from "@oxagen/work";
import { WorkRecordError } from "@oxagen/work/records";

const { send } = vi.hoisted(() => ({ send: vi.fn(async (_events: unknown) => undefined) }));
vi.mock("../../event-client", () => ({ eventClient: { send } }));

const { itemNotFound, sendWorkEvents, workRefusal } = await import("./handler-support");
const { CollectorSetupError } = await import("./collectors");

describe("workRefusal", () => {
  it.each([
    ["invalid_input", CapabilityError, "invalid_input"],
    ["forbidden", HandlerError, "forbidden"],
    ["not_found", HandlerError, "not_found"],
    ["stale_version", HandlerError, "conflict"],
    ["not_allowed", HandlerError, "conflict"],
  ] as const)("maps a work record %s refusal", (code, kind, expected) => {
    const refusal = workRefusal("revise_work_triage", new WorkRecordError(code, "Read it again."));
    expect(refusal).toBeInstanceOf(kind);
    expect((refusal as { code: string }).code).toBe(expected);
    expect((refusal as Error).message).toBe("Read it again.");
  });

  it("maps a correction error and each collector setup error", () => {
    expect((workRefusal("revise_work_triage", new TriageCorrectionError("Bad")) as CapabilityError).code).toBe("invalid_input");
    expect((workRefusal("set_work_collector", new CollectorSetupError("invalid_input", "x")) as CapabilityError).code).toBe("invalid_input");
    const missing = workRefusal("set_work_collector", new CollectorSetupError("not_found", "no connection")) as HandlerError;
    expect([missing.code, missing.reason]).toEqual(["not_found", "collector_not_found"]);
    expect((workRefusal("set_work_collector", new CollectorSetupError("conflict", "x")) as HandlerError).code).toBe("conflict");
  });

  it("returns any other error unchanged", () => {
    const error = new Error("db down");
    expect(workRefusal("create_work_item", error)).toBe(error);
  });
});

describe("sendWorkEvents and itemNotFound", () => {
  it("sends events through the event client, and nothing for none", async () => {
    await sendWorkEvents([]);
    expect(send).not.toHaveBeenCalled();
    await sendWorkEvents([{ name: "work/item.received", data: { item_id: "wi_1" } }]);
    expect(send).toHaveBeenCalledWith([{ name: "work/item.received", data: { item_id: "wi_1" } }]);
  });

  it("names the missing item", () => {
    expect(itemNotFound("wi_9").message).toBe("This workspace has no work item wi_9.");
  });
});
