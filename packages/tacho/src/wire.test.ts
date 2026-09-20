import { describe, expect, it } from "vitest";
import {
  bundleResponseSchema,
  controlEnvelopeSchema,
  deliveredCommandSchema,
  ingestResponseSchema,
  commandsResponseSchema,
  tachoBatchSchema,
  TACHO_MAX_BODY_BYTES,
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

const COMMAND = {
  id: "cmd_1",
  command: "steer",
  session_uuid: null,
  payload: { text: "Review the failed request" },
  requested_mode: "next_step",
  delivery_mode: "next_step",
  degraded_reason: null,
  reason: "Operator feedback",
  issued_at: "2026-09-20T00:00:00Z",
  expires_at: null,
};

const commandResponses = [
  {
    name: "command poll",
    parse: (command: unknown) =>
      commandsResponseSchema.parse({
        acknowledged: 0,
        control: { ...CONTROL, commands: [command] },
      }),
  },
  {
    name: "ingest",
    parse: (command: unknown) =>
      ingestResponseSchema.parse({
        accepted: 1,
        event_ids: ["evt_1"],
        chain_breaks: [],
        control: { ...CONTROL, commands: [command] },
      }),
  },
];

describe.each(commandResponses)("commands in $name responses", ({ parse }) => {
  it("accepts additive metadata without changing known command fields", () => {
    const parsed = parse({ ...COMMAND, priority: 1 });
    expect(parsed.control.commands).toEqual([{ ...COMMAND, priority: 1 }]);
  });

  it.each([
    ["missing id", { ...COMMAND, id: undefined }],
    ["unknown command", { ...COMMAND, command: "future-command" }],
    ["invalid payload", { ...COMMAND, payload: null }],
    ["invalid delivery mode", { ...COMMAND, delivery_mode: "future-mode" }],
  ] as const)("still rejects %s", (_name, command) => {
    expect(() => parse({ ...command, priority: 1 })).toThrow();
  });
});

describe("what this host sends", () => {
  it("keeps produced commands strict while receiving additive metadata", () => {
    expect(deliveredCommandSchema.parse(COMMAND)).toEqual(COMMAND);
    expect(() =>
      deliveredCommandSchema.parse({ ...COMMAND, priority: 1 }),
    ).toThrow();
  });

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

  it("carries frame bodies next to their events, and no more than the wire allows", () => {
    // What the shipper actually sends: a body per content frame, base64 on
    // the wire, naming the event by its idempotency id. The server verifies
    // each body against the event's `content.digest`; this proves the batch
    // that carries them parses at all.
    const events = minimalSession();
    const prompt = events[1];
    const batch = {
      schema: TACHO_BATCH_SCHEMA,
      host_enrollment_id: "tch_0123456789abcdefghijkl",
      events,
      bodies: [
        {
          event_id_idem: prompt?.event_id_idem,
          content_type: "text/plain; charset=utf-8",
          bytes_base64: Buffer.from("Read README.md").toString("base64"),
        },
      ],
    };
    expect(() => tachoBatchSchema.parse(batch)).not.toThrow();
    // A body is strict too: a member the server does not know is drift.
    expect(() =>
      tachoBatchSchema.parse({
        ...batch,
        bodies: [{ ...batch.bodies[0], digest: "sha256:00" }],
      }),
    ).toThrow();
    // The base64 cap is the byte cap the recorder enforces, so a body the
    // recorder let through is never one the wire refuses.
    const atCap = Buffer.alloc(TACHO_MAX_BODY_BYTES, 0x61).toString("base64");
    expect(() =>
      tachoBatchSchema.parse({
        ...batch,
        bodies: [{ ...batch.bodies[0], bytes_base64: atCap }],
      }),
    ).not.toThrow();
    const overCap = Buffer.alloc(TACHO_MAX_BODY_BYTES + 3, 0x61).toString(
      "base64",
    );
    expect(() =>
      tachoBatchSchema.parse({
        ...batch,
        bodies: [{ ...batch.bodies[0], bytes_base64: overCap }],
      }),
    ).toThrow();
  });
});
