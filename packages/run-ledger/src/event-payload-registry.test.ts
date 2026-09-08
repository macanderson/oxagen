/**
 * Unit coverage for the closed V2 event vocabulary, the inline-payload
 * defences, and the digest contract.
 *
 * The `PINNED VECTOR` assertions are a CROSS-PR contract, not ordinary
 * expectations. PR 2's finalizer recomputes `event_stream_digest` from the
 * authoritative event log and compares it to the value the seal committed to;
 * if a change to `canonicalJson` or to the fold shape moves these bytes, every
 * manifest fails validation at once. A failing vector is a merge blocker, never
 * a test to update.
 */
import { describe, it, expect } from "vitest";
import {
  advanceEventStreamDigest,
  assertInlinePayloadWithinCap,
  assertNoForbiddenPayloadFields,
  computeEventDigest,
  computeEventStreamDigest,
  EMPTY_EVENT_STREAM_DIGEST,
  EVENT_SCHEMA_VERSION,
  EVENT_TYPE_REGISTRY,
  EVIDENCE_STAGES,
  isContentClassRetained,
  isForbiddenPayloadKey,
  isRunEventType,
  isTerminalEventType,
  MAX_INLINE_PAYLOAD_BYTES,
  requireEventTypeDefinition,
  retentionContentClassOf,
  RETENTION_CONTENT_CLASSES,
  RUN_EVENT_TYPES,
  stageOfEventType,
  TERMINAL_EVENT_TYPE,
  validateEncryptedEventReference,
  validateInlineEventPayload,
} from "./event-payload-registry";
import {
  ForbiddenEventPayloadFieldError,
  RunEventPayloadTooLargeError,
  RunSpecValidationError,
  UnknownRunEventTypeError,
} from "./run-errors";

const DIGEST_A =
  "sha256:0000000000000000000000000000000000000000000000000000000000000001";
const DIGEST_B =
  "sha256:0000000000000000000000000000000000000000000000000000000000000002";
const DIGEST_C =
  "sha256:0000000000000000000000000000000000000000000000000000000000000003";
const BLOB_REF = "evb_0123456789abcdef0123";
const DECISION_REF = "azd_0123456789abcdef0123";
const ATTEMPT_REF = "arat_0123456789abcdef0123";
const OBSERVED_AT = "2026-07-21T12:00:00.000Z";

function admissionPayload() {
  return {
    attempt_public_id: ATTEMPT_REF,
    attempt_number: 1,
    max_attempts: 3,
    spec_digest: DIGEST_A,
    authorization_snapshot_digest: DIGEST_B,
    grant_ceiling_digest: DIGEST_C,
    engine_name: "ts",
    engine_version: "2.1.1",
    engine_build_digest: DIGEST_A,
  };
}

// ── The registry itself ─────────────────────────────────────────────────────

describe("EVENT_TYPE_REGISTRY", () => {
  it("stamps every entry with one of the nine evidence stages", () => {
    for (const [type, definition] of Object.entries(EVENT_TYPE_REGISTRY)) {
      expect(EVIDENCE_STAGES, `${type} declares an unknown stage`).toContain(
        definition.stage,
      );
    }
  });

  it("declares a known retention content class for every entry", () => {
    for (const [type, definition] of Object.entries(EVENT_TYPE_REGISTRY)) {
      expect(
        RETENTION_CONTENT_CLASSES,
        `${type} declares an unknown content class`,
      ).toContain(definition.contentClass);
    }
  });

  it("covers all nine stages so no stage is unrepresentable", () => {
    const covered = new Set(
      Object.values(EVENT_TYPE_REGISTRY).map((d) => d.stage),
    );
    expect([...covered].sort()).toEqual([...EVIDENCE_STAGES].sort());
  });

  it("has exactly one terminal-stage type, and it is TERMINAL_EVENT_TYPE", () => {
    const terminal = RUN_EVENT_TYPES.filter(
      (t) => EVENT_TYPE_REGISTRY[t].stage === "terminal",
    );
    expect(terminal).toEqual([TERMINAL_EVENT_TYPE]);
  });
});

describe("isRunEventType / requireEventTypeDefinition", () => {
  it("accepts a registered type", () => {
    expect(isRunEventType("model.call_completed")).toBe(true);
    expect(requireEventTypeDefinition("model.call_completed").stage).toBe(
      "model",
    );
  });

  it("rejects an unregistered type before any SQL exists", () => {
    expect(isRunEventType("model.freeform")).toBe(false);
    expect(() => requireEventTypeDefinition("model.freeform")).toThrow(
      UnknownRunEventTypeError,
    );
  });

  it("rejects an inherited Object.prototype key as a type", () => {
    // `hasOwnProperty`-based lookup, not `in`: "constructor" must not resolve.
    expect(isRunEventType("constructor")).toBe(false);
    expect(isRunEventType("toString")).toBe(false);
  });

  it("exposes stage and retention class by type", () => {
    expect(stageOfEventType("tool.call_completed")).toBe("tool");
    expect(retentionContentClassOf("tool.call_completed")).toBe("tool_call");
    expect(retentionContentClassOf("tool.approval_recorded")).toBe(
      "approval_receipt",
    );
  });

  it("answers whether a pinned retention policy authorizes the payload", () => {
    expect(isContentClassRetained("model.call_completed", ["model_call"])).toBe(
      true,
    );
    expect(isContentClassRetained("model.call_completed", ["tool_call"])).toBe(
      false,
    );
    expect(isContentClassRetained("model.call_completed", [])).toBe(false);
  });

  it("identifies the terminal event type", () => {
    expect(isTerminalEventType(TERMINAL_EVENT_TYPE)).toBe(true);
    expect(isTerminalEventType("model.call_completed")).toBe(false);
    expect(isTerminalEventType("not.registered")).toBe(false);
  });
});

// ── Forbidden inline content ────────────────────────────────────────────────

describe("isForbiddenPayloadKey", () => {
  it("refuses an exact raw-content root", () => {
    for (const key of [
      "path",
      "uri",
      "content",
      "prompt",
      "diff",
      "stdout",
      "stderr",
      "body",
      "credential",
      "embedding",
    ]) {
      expect(isForbiddenPayloadKey(key), key).toBe(true);
    }
  });

  it("refuses a suffixed raw-content root", () => {
    for (const key of [
      "file_path",
      "source_uri",
      "raw_content",
      "system_prompt",
      "tool_stdout",
      "model_body",
      "api_key_credential",
    ]) {
      expect(isForbiddenPayloadKey(key), key).toBe(true);
    }
  });

  it("normalizes case and dashes", () => {
    expect(isForbiddenPayloadKey("File-Path")).toBe(true);
    expect(isForbiddenPayloadKey("STDOUT")).toBe(true);
  });

  it("permits digest, ref, and id forms that carry no raw bytes", () => {
    for (const key of [
      "uri_digest",
      "prompt_content_digest",
      "transmitted_request_body_digest",
      "encrypted_patch_ref",
      "path_locator_public_id",
      "input_tokens",
      "token_cost",
      "tokenizer_ref",
      "changed_file_count",
    ]) {
      expect(isForbiddenPayloadKey(key), key).toBe(false);
    }
  });
});

describe("assertNoForbiddenPayloadFields", () => {
  it("passes a payload of digests and references", () => {
    expect(() =>
      assertNoForbiddenPayloadFields(admissionPayload(), "x"),
    ).not.toThrow();
  });

  it("finds a forbidden field nested inside an object", () => {
    expect(() =>
      assertNoForbiddenPayloadFields(
        { receipt: { nested: { file_path: "/etc/passwd" } } },
        "x",
      ),
    ).toThrow(ForbiddenEventPayloadFieldError);
  });

  it("finds a forbidden field nested inside an array", () => {
    let caught: unknown;
    try {
      assertNoForbiddenPayloadFields({ frames: [{ uri: "https://x" }] }, "x");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForbiddenEventPayloadFieldError);
    expect((caught as ForbiddenEventPayloadFieldError).fields).toEqual([
      "frames.0.uri",
    ]);
  });

  it("reports every offender, not just the first", () => {
    let caught: unknown;
    try {
      assertNoForbiddenPayloadFields({ prompt: "a", diff: "b" }, "x");
    } catch (err) {
      caught = err;
    }
    expect(
      [...(caught as ForbiddenEventPayloadFieldError).fields].sort(),
    ).toEqual(["diff", "prompt"]);
  });

  it("ignores scalars and nulls", () => {
    expect(() => assertNoForbiddenPayloadFields(null, "x")).not.toThrow();
    expect(() => assertNoForbiddenPayloadFields("text", "x")).not.toThrow();
    expect(() => assertNoForbiddenPayloadFields(7, "x")).not.toThrow();
  });
});

// ── Inline payload validation ───────────────────────────────────────────────

describe("validateInlineEventPayload", () => {
  it("accepts a well-formed admission receipt and digests the canonical bytes", () => {
    const result = validateInlineEventPayload(
      "admission.run_admitted",
      admissionPayload(),
    );
    expect(result.stage).toBe("admission");
    expect(result.eventSchemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(result.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.canonicalBytes).toBeGreaterThan(0);
  });

  it("accepts a tool receipt of digests and kernel references", () => {
    const result = validateInlineEventPayload("tool.call_completed", {
      tool_call_id: "call_1",
      capability_name: "edit_repo_file",
      outcome: "completed",
      input_digest: DIGEST_A,
      output_digest: DIGEST_B,
      encrypted_output_ref: BLOB_REF,
      authorization_decision_ref: DECISION_REF,
      duration_ms: 1200,
    });
    expect(result.stage).toBe("tool");
    expect(result.eventType).toBe("tool.call_completed");
  });

  it("rejects a tool receipt whose authorization decision ref is not azd_", () => {
    expect(() =>
      validateInlineEventPayload("tool.call_completed", {
        tool_call_id: "call_1",
        capability_name: "edit_repo_file",
        outcome: "completed",
        input_digest: DIGEST_A,
        authorization_decision_ref: "arun_0123456789abcdef0123",
        duration_ms: 1,
      }),
    ).toThrow(RunSpecValidationError);
  });

  it("digests independently of key order", () => {
    const a = validateInlineEventPayload("checkout.unavailable", {
      reason_code: "sandbox_unavailable",
      provider_repository_id: "1234",
    });
    const b = validateInlineEventPayload("checkout.unavailable", {
      provider_repository_id: "1234",
      reason_code: "sandbox_unavailable",
    });
    expect(a.payloadDigest).toBe(b.payloadDigest);
  });

  it("rejects an unknown event type before schema parsing", () => {
    expect(() => validateInlineEventPayload("nope.at_all", {})).toThrow(
      UnknownRunEventTypeError,
    );
  });

  it("rejects a smuggled raw field with the forbidden-field error, not a schema error", () => {
    expect(() =>
      validateInlineEventPayload("checkout.unavailable", {
        reason_code: "sandbox_unavailable",
        provider_repository_id: "1234",
        stdout: "…",
      }),
    ).toThrow(ForbiddenEventPayloadFieldError);
  });

  it("rejects an unknown key the forbidden scan allows (strict schema)", () => {
    expect(() =>
      validateInlineEventPayload("checkout.unavailable", {
        reason_code: "sandbox_unavailable",
        provider_repository_id: "1234",
        extra_field_ref: "surprise",
      }),
    ).toThrow(RunSpecValidationError);
  });

  it("rejects a malformed digest inside an otherwise valid payload", () => {
    expect(() =>
      validateInlineEventPayload("admission.run_admitted", {
        ...admissionPayload(),
        spec_digest: "deadbeef",
      }),
    ).toThrow(RunSpecValidationError);
  });

  it("rejects a public id bearing the wrong prefix", () => {
    expect(() =>
      validateInlineEventPayload("admission.run_admitted", {
        ...admissionPayload(),
        attempt_public_id: "arun_0123456789abcdef0123",
      }),
    ).toThrow(RunSpecValidationError);
  });

  it("leaves a schema-bounded receipt comfortably under the cap", () => {
    const result = validateInlineEventPayload("checkout.unavailable", {
      reason_code: "sandbox_unavailable",
      provider_repository_id: "x".repeat(256),
    });
    expect(result.canonicalBytes).toBeLessThan(MAX_INLINE_PAYLOAD_BYTES);
  });

  it("refuses an oversized payload BEFORE walking or parsing it", () => {
    // The size guard must fire ahead of the forbidden-field walk and the Zod
    // parse: a multi-megabyte payload should not be traversed key by key just
    // to be told it is too big.
    const huge = {
      reason_code: "sandbox_unavailable",
      provider_repository_id: "y".repeat(MAX_INLINE_PAYLOAD_BYTES + 1),
    };
    let caught: unknown;
    try {
      validateInlineEventPayload("checkout.unavailable", huge);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunEventPayloadTooLargeError);
    expect((caught as RunEventPayloadTooLargeError).limit).toBe(
      MAX_INLINE_PAYLOAD_BYTES,
    );
    expect((caught as RunEventPayloadTooLargeError).eventType).toBe(
      "checkout.unavailable",
    );
  });

  it("refuses oversized bulk even when it also carries a forbidden field", () => {
    expect(() =>
      validateInlineEventPayload("checkout.unavailable", {
        stdout: "z".repeat(MAX_INLINE_PAYLOAD_BYTES + 1),
      }),
    ).toThrow(RunEventPayloadTooLargeError);
  });

  it("rejects a float where the canonical form requires a safe integer", () => {
    expect(() =>
      validateInlineEventPayload("change.recorded", {
        path_locator_public_id: "rpl_0123456789abcdef0123",
        change_kind: "modify",
        before_digest: DIGEST_A,
        after_digest: DIGEST_B,
        classification_authority: "runner_observed",
        classification_method: "static",
        classification_input_digest: DIGEST_C,
        classification_confidence_per_mille: 0.5,
      }),
    ).toThrow(RunSpecValidationError);
  });
});

describe("MAX_INLINE_PAYLOAD_BYTES", () => {
  it("is the spec's 32 KiB, measured on canonical bytes", () => {
    expect(MAX_INLINE_PAYLOAD_BYTES).toBe(32 * 1024);
  });

  it("tolerates a payload JSON.stringify cannot serialize, leaving canonicalJson to refuse it", () => {
    // A BigInt makes `JSON.stringify` throw. The guard must not mask that as a
    // size failure — canonicalization refuses it with a precise reason instead.
    expect(() =>
      assertInlinePayloadWithinCap("checkout.unavailable", { n: 1n }),
    ).not.toThrow();
    // `undefined` serializes to `undefined`, not a string — also skipped.
    expect(() =>
      assertInlinePayloadWithinCap("checkout.unavailable", undefined),
    ).not.toThrow();
  });
});

describe("validateEncryptedEventReference", () => {
  it("accepts an evb_ reference plus a sha256 payload digest", () => {
    const result = validateEncryptedEventReference(
      "context.frames_selected",
      BLOB_REF,
      DIGEST_A,
    );
    expect(result.stage).toBe("context");
    expect(result.payloadDigest).toBe(DIGEST_A);
  });

  it("rejects an unknown event type", () => {
    expect(() =>
      validateEncryptedEventReference("nope.at_all", BLOB_REF, DIGEST_A),
    ).toThrow(UnknownRunEventTypeError);
  });

  it("rejects a reference that is not an evb_ public id", () => {
    expect(() =>
      validateEncryptedEventReference(
        "context.frames_selected",
        "arun_0123456789abcdef0123",
        DIGEST_A,
      ),
    ).toThrow(RunSpecValidationError);
  });

  it("rejects a missing or malformed payload digest", () => {
    expect(() =>
      validateEncryptedEventReference("context.frames_selected", BLOB_REF, ""),
    ).toThrow(RunSpecValidationError);
  });

  it("reports both problems at once", () => {
    let caught: unknown;
    try {
      validateEncryptedEventReference("context.frames_selected", "bad", "bad");
    } catch (err) {
      caught = err;
    }
    expect((caught as RunSpecValidationError).issues).toHaveLength(2);
  });
});

// ── Digests ─────────────────────────────────────────────────────────────────

describe("computeEventDigest", () => {
  const base = {
    attemptSeq: 1,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    eventType: "model.call_completed",
    stage: "model",
    payloadDigest: DIGEST_A,
    observedAt: OBSERVED_AT,
  };

  it("PINNED VECTOR — a known event digests to a stable value", () => {
    // Independently reproduced with plain `JSON.stringify` over the six keys in
    // sorted order plus node's sha256 — i.e. NOT copied out of this module's
    // own output, so it pins the canonical form and not just today's behavior:
    //   {"attempt_seq":1,"event_schema_version":"agent-run-event/v2",
    //    "event_type":"model.call_completed",
    //    "observed_at":"2026-07-21T12:00:00.000Z",
    //    "payload_digest":"sha256:00…01","stage":"model"}
    expect(computeEventDigest(base)).toBe(
      "sha256:9d09acea89e287ed093d184ef15d3be60b77fd705054b0f9d89600ea339b3e85",
    );
  });

  it("is deterministic", () => {
    expect(computeEventDigest(base)).toBe(computeEventDigest(base));
  });

  it("changes when the attempt sequence changes", () => {
    expect(computeEventDigest({ ...base, attemptSeq: 2 })).not.toBe(
      computeEventDigest(base),
    );
  });

  it("changes when the stage changes", () => {
    expect(computeEventDigest({ ...base, stage: "tool" })).not.toBe(
      computeEventDigest(base),
    );
  });

  it("changes when the observed time changes — a re-stamped clock self-conflicts", () => {
    expect(
      computeEventDigest({ ...base, observedAt: "2026-07-21T12:00:01.000Z" }),
    ).not.toBe(computeEventDigest(base));
  });
});

describe("event stream digest", () => {
  const entry = (attemptSeq: number, payloadDigest: string) => ({
    attemptSeq,
    eventSchemaVersion: EVENT_SCHEMA_VERSION,
    eventType: "model.call_completed",
    payloadDigest,
  });

  it("PINNED VECTOR — the empty stream digest is sha256 of the two bytes `[]`", () => {
    // The one value a zero-event abandoned attempt seals with. Verifiable by
    // hand: `printf '[]' | shasum -a 256`.
    expect(EMPTY_EVENT_STREAM_DIGEST).toBe(
      "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
  });

  it("PINNED VECTOR — a three-event stream", () => {
    // Independently reproduced with plain `JSON.stringify` + node sha256,
    // folding {"entry":[seq,schema,type,payload_digest],"previous":<prior>}
    // three times from the empty-stream seed.
    expect(
      computeEventStreamDigest([
        entry(1, DIGEST_A),
        entry(2, DIGEST_B),
        entry(3, DIGEST_C),
      ]),
    ).toBe(
      "sha256:c755b79f5e43fd23e02ceac44f11cb48d305c2d85595204f3d8562c16270c357",
    );
  });

  it("computes an empty list as the seed", () => {
    expect(computeEventStreamDigest([])).toBe(EMPTY_EVENT_STREAM_DIGEST);
  });

  it("folds incrementally to the same value as a whole-list recompute", () => {
    // This IS the cross-PR contract: the lease advances the digest one event at
    // a time, PR 2's finalizer recomputes it from the whole log, and the two
    // must agree byte for byte.
    const entries = [
      entry(1, DIGEST_A),
      entry(2, DIGEST_B),
      entry(3, DIGEST_C),
    ];
    let running: string = EMPTY_EVENT_STREAM_DIGEST;
    for (const e of entries) running = advanceEventStreamDigest(running, e);
    expect(running).toBe(computeEventStreamDigest(entries));
  });

  it("is order sensitive", () => {
    expect(
      computeEventStreamDigest([entry(1, DIGEST_A), entry(2, DIGEST_B)]),
    ).not.toBe(
      computeEventStreamDigest([entry(1, DIGEST_B), entry(2, DIGEST_A)]),
    );
  });

  it("commits to the payload digest", () => {
    expect(computeEventStreamDigest([entry(1, DIGEST_A)])).not.toBe(
      computeEventStreamDigest([entry(1, DIGEST_B)]),
    );
  });

  it("commits to the event type", () => {
    expect(computeEventStreamDigest([entry(1, DIGEST_A)])).not.toBe(
      computeEventStreamDigest([
        { ...entry(1, DIGEST_A), eventType: "tool.call_completed" },
      ]),
    );
  });

  it("does NOT commit to stage or observed time — those live on event_digest", () => {
    // A stream entry has exactly four fields. Extra properties on the input
    // object are ignored, which is what keeps the digest reproducible from the
    // envelope's own tuple list rather than from a database row.
    const withExtras = {
      ...entry(1, DIGEST_A),
      stage: "model",
      observedAt: OBSERVED_AT,
    };
    expect(computeEventStreamDigest([withExtras])).toBe(
      computeEventStreamDigest([entry(1, DIGEST_A)]),
    );
  });
});
