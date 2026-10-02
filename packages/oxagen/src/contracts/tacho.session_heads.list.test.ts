import { describe, expect, it } from "vitest";
import { tachoSessionHeadsList as contract } from "./tacho.session_heads.list";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  session_uuids: [UUID],
  harness_session_ids: ["0b1f0000-0000-4000-8000-00000000b001"],
};

describe("backfill session heads contract", () => {
  it("is a read the host key makes on the API surface only", () => {
    expect(contract.name).toBe("list_tacho_session_heads");
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.input.safeParse(input).success).toBe(true);
    const { harness_session_ids: _ids, ...byUuid } = input;
    expect(contract.input.safeParse(byUuid).success).toBe(true);
  });

  it("refuses a malformed batch", () => {
    for (const patch of [
      { host_enrollment_id: "host" },
      { session_uuids: [] },
      { session_uuids: ["not-a-uuid"] },
      { session_uuids: Array.from({ length: 501 }, () => UUID) },
      { harness_session_ids: ["../etc/passwd"] },
      { harness_session_ids: ["a".repeat(129)] },
      { harness_session_ids: Array.from({ length: 501 }, () => "a") },
      { scope: "everything" },
    ]) {
      expect(
        contract.input.safeParse({ ...input, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("answers each session's head and record basis", () => {
    const head = {
      session_uuid: UUID,
      harness_session_id: "0b1f0000-0000-4000-8000-00000000b001",
      seq_count: 3,
      record_basis: "backfill",
      backfill_normalizer: "1",
    };
    expect(contract.output.safeParse({ sessions: [head] }).success).toBe(true);
    expect(
      contract.output.safeParse({
        sessions: [{ ...head, record_basis: "replayed" }],
      }).success,
    ).toBe(false);
  });
});
