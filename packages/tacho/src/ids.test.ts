import { describe, expect, it } from "vitest";
import {
  effectId,
  eventIdIdem,
  newEventId,
  sessionUuid,
  ulid,
  uuidv5,
} from "./ids";

describe("deterministic ids", () => {
  it("implements RFC 4122 name-based UUID v5 (known vector)", () => {
    const dnsNamespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(uuidv5(dnsNamespace, "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("derives the same session uuid for the same scope and harness session", () => {
    const a = sessionUuid("thst_a", "sess-1");
    expect(sessionUuid("thst_a", "sess-1")).toBe(a);
    expect(sessionUuid("thst_b", "sess-1")).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("derives the idempotency id from (session_uuid, seq) and refuses bad seq", () => {
    const uuid = sessionUuid("thst_a", "sess-1");
    expect(eventIdIdem(uuid, 0)).toMatch(/^evt_[0-9a-f]{64}$/);
    expect(eventIdIdem(uuid, 0)).toBe(eventIdIdem(uuid, 0));
    expect(eventIdIdem(uuid, 1)).not.toBe(eventIdIdem(uuid, 0));
    expect(() => eventIdIdem(uuid, -1)).toThrow(TypeError);
    expect(() => eventIdIdem(uuid, 1.5)).toThrow(TypeError);
  });

  it("names an intended-once effect by session, tool use, and target", () => {
    const uuid = sessionUuid("thst_a", "sess-1");
    expect(effectId(uuid, "toolu_1", "/tmp/a")).toBe(
      effectId(uuid, "toolu_1", "/tmp/a"),
    );
    expect(effectId(uuid, "toolu_1", "/tmp/a")).not.toBe(
      effectId(uuid, "toolu_1", "/tmp/b"),
    );
  });

  it("mints ULIDs that sort by time", () => {
    const earlier = ulid(1_000_000);
    const later = ulid(2_000_000);
    expect(earlier).toHaveLength(26);
    expect(earlier < later).toBe(true);
    expect(newEventId()).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
