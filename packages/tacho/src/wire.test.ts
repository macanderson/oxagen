import { describe, expect, it } from "vitest";
import {
  bundleResponseSchema,
  controlEnvelopeSchema,
  ingestResponseSchema,
  commandsResponseSchema,
  tachoBatchSchema,
  TACHO_BATCH_SCHEMA,
} from "./wire";
import { minimalSession } from "./test-helpers";

/**
 * Forward compatibility with a control plane newer than this host.
 *
 * A host is installed on someone's machine and updates when they get round to
 * it; the control plane deploys continuously, so it WILL answer hosts older
 * than itself. Under a strict response schema each additive server field is a
 * fleet-wide ingest outage that reports itself as health: the response fails to
 * parse, the batch is never acknowledged, the spool grows, and `tacho status`
 * still says the daemon is up. `body_rejections` did exactly that — 3,526
 * events stranded on one host with "last ingest never" — and it was the third
 * time, after `user_email` and the bundle.
 */
const CONTROL = {
  host_status: "active",
  deny_generation: { org: 0, workspace: 0 },
  bundle_etag: "etag-1",
  commands: [],
};

describe("responses from the control plane", () => {
  it("parses an ingest response carrying body_rejections", () => {
    const parsed = ingestResponseSchema.parse({
      accepted: 1,
      event_ids: ["evt_1"],
      chain_breaks: [],
      body_rejections: [
        { event_id_idem: "evt_1", reason: "retention_digest_only" },
      ],
      control: CONTROL,
    });
    expect(parsed.accepted).toBe(1);
    expect(parsed.body_rejections).toHaveLength(1);
  });

  it("parses an ingest response from a control plane OLDER than this host, which sends none", () => {
    const parsed = ingestResponseSchema.parse({
      accepted: 1,
      event_ids: ["evt_1"],
      chain_breaks: [],
      control: CONTROL,
    });
    expect(parsed.body_rejections).toBeUndefined();
  });

  it("ignores a field this host has never heard of rather than failing the batch", () => {
    const parsed = ingestResponseSchema.parse({
      accepted: 1,
      event_ids: ["evt_1"],
      chain_breaks: [],
      control: { ...CONTROL, some_field_shipped_next_quarter: { a: 1 } },
      a_field_shipped_next_year: "whatever",
    });
    // The fields this host DOES understand still arrive intact; the rest is
    // carried through rather than treated as corruption.
    expect(parsed.accepted).toBe(1);
    expect(parsed.control.host_status).toBe("active");
  });

  it("does the same for the bundle and the control envelope", () => {
    expect(() =>
      bundleResponseSchema.parse({
        not_modified: true,
        etag: "etag-1",
        bundle: null,
        added_later: true,
      }),
    ).not.toThrow();
    expect(() =>
      controlEnvelopeSchema.parse({ ...CONTROL, added_later: true }),
    ).not.toThrow();
  });

  it("still rejects a response missing a field this host depends on", () => {
    // Tolerance is about EXTRA keys. A response that omits something the host
    // reads is still a broken response and must not parse into undefined.
    expect(() =>
      ingestResponseSchema.parse({
        accepted: 1,
        event_ids: ["evt_1"],
        chain_breaks: [],
        // no `control`
      }),
    ).toThrow();
  });
});

describe("the command-poll response wrapper", () => {
  // The wrapper is parsed before `control` is ever read, so a tolerant
  // envelope inside a strict wrapper still stopped a host polling the moment
  // a newer control plane added one top-level field.
  it("accepts a field a newer control plane added at the top level", () => {
    const parsed = commandsResponseSchema.safeParse({
      acknowledged: 0,
      control: CONTROL,
      server_hint: "added later",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("what this host sends", () => {
  it("is still strict, so drift in our own batch is caught here and not by the server", () => {
    // The batch is otherwise VALID — `events: []` alone violates `.min(1)`, so
    // a batch that was empty as well as unexpected would throw even after
    // `tachoBatchSchema` lost its `.strict()`, and the assertion would pass for
    // the wrong reason while the strictness regression went unnoticed. The
    // unknown key has to be the only thing wrong with it.
    const batch = {
      schema: TACHO_BATCH_SCHEMA,
      host_enrollment_id: "tch_0123456789abcdefghijkl",
      events: minimalSession(),
    };
    expect(() => tachoBatchSchema.parse(batch)).not.toThrow();
    expect(() =>
      tachoBatchSchema.parse({ ...batch, unexpected: true }),
    ).toThrow();
  });
});
