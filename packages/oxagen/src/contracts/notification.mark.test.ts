import { describe, it, expect } from "vitest";
import { notificationsMark } from "./notification.mark";

describe("notifications.mark contract", () => {
  it("has the correct name and domain", () => {
    expect(notificationsMark.name).toBe("mark_notification");
    expect(notificationsMark.domain).toBe("notification");
  });

  it("parses valid input with read=true", () => {
    const parsed = notificationsMark.input.parse({ id: "ntf_abc", read: true });
    expect(parsed.id).toBe("ntf_abc");
    expect(parsed.read).toBe(true);
  });

  it("rejects empty id", () => {
    expect(() => notificationsMark.input.parse({ id: "" })).toThrow();
  });

  it("parses archived=true alone (read optional)", () => {
    const parsed = notificationsMark.input.parse({
      id: "ntf_abc",
      archived: true,
    });
    expect(parsed.archived).toBe(true);
    expect(parsed.read).toBeUndefined();
  });

  it("output schema accepts ok:true", () => {
    const parsed = notificationsMark.output.parse({ ok: true });
    expect(parsed.ok).toBe(true);
  });
});
