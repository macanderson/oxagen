import { describe, expect, it } from "vitest";
import { runFrameBodyGet } from "./run.frame_body.get";

const RUN = "arun_5f0c2e9a1b7d4c3e8f6a02";
const DIGEST = `sha256:${"a".repeat(64)}`;

describe("get_run_frame_body contract", () => {
  it("is a console read: mutates false, noBillingGate true, high sensitivity", () => {
    expect(runFrameBodyGet.mutates).toBe(false);
    expect(runFrameBodyGet.noBillingGate).toBe(true);
    expect(runFrameBodyGet.scoped).toBe(true);
    expect(runFrameBodyGet.sensitivity).toBe("high");
    expect(runFrameBodyGet.defaultEffect).toBe("deny");
  });

  it("takes a run id from either store and a decimal sequence", () => {
    expect(runFrameBodyGet.input.parse({ runId: RUN, seq: "0" })).toEqual({
      runId: RUN,
      seq: "0",
    });
    expect(
      runFrameBodyGet.input.safeParse({ runId: "tse_0a1b2c", seq: "17" })
        .success,
    ).toBe(true);
    expect(
      runFrameBodyGet.input.safeParse({ runId: RUN, seq: "-1" }).success,
    ).toBe(false);
    expect(
      runFrameBodyGet.input.safeParse({ runId: RUN, seq: 3 }).success,
    ).toBe(false);
    expect(
      runFrameBodyGet.input.safeParse({ runId: RUN, seq: "1", extra: 1 })
        .success,
    ).toBe(false);
  });

  it("answers bytes or null with the recorded digest either way", () => {
    expect(
      runFrameBodyGet.output.safeParse({
        contentType: "application/json",
        bytes: "eyJhIjoxfQ==",
        digest: DIGEST,
        redactions: [],
      }).success,
    ).toBe(true);
    expect(
      runFrameBodyGet.output.safeParse({
        contentType: null,
        bytes: null,
        digest: DIGEST,
        redactions: [
          { path: "bytes:0-10", reason: "jwt", originalDigest: DIGEST },
        ],
      }).success,
    ).toBe(true);
    expect(
      runFrameBodyGet.output.safeParse({
        contentType: null,
        bytes: null,
        digest: "md5:abc",
        redactions: [],
      }).success,
    ).toBe(false);
  });
});
