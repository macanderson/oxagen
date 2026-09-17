/**
 * The address of the person behind a session must never reach a store (#3072).
 *
 * `tacho_events` had one readable personal identifier, `anthropic_user_email`,
 * while every sibling identity column on the same table was a digest — and
 * ClickHouse has no row policy, so an ordinary analytics query could read a
 * real address back out. These tests hold the fix in place from both ends: the
 * collector digests on the host, and nothing downstream carries a column or an
 * envelope member that could hold the address again.
 */
import { describe, expect, it } from "vitest";
import { normalizeOtlp } from "./claude-code/otel";
import { SessionRecorder } from "./claude-code/recorder";
import { ENVELOPE_COLUMNS, TACHO_EVENT_COLUMNS, flattenEvent } from "./columns";
import { digestBytes, digestUserEmail, isSha256Digest } from "./digest";
import { anthropicSchema } from "./envelope";
import { TEST_HOST, TEST_SESSION_ID } from "./test-helpers";

const ADDRESS = "Ada.Lovelace@example.com";
const NORMALIZED = "ada.lovelace@example.com";

/** Every string anywhere in a JSON-shaped value, however deeply nested. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value !== null && typeof value === "object")
    for (const member of Object.values(value)) strings(member, out);
  return out;
}

function otlpLog(attrs: Record<string, string>) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "os.type", value: { stringValue: "linux" } }],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1788861970750000000",
                body: { stringValue: "claude_code.api_request" },
                attributes: Object.entries(attrs).map(([key, value]) => ({
                  key,
                  value: { stringValue: value },
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("digestUserEmail", () => {
  it("is domain-separated, so it is not a lookup away from the address", () => {
    // An email address carries little enough entropy that a bare sha256 of one
    // is reversible against any address list. If this ever equals the plain
    // digest, the domain separator has been dropped.
    expect(digestUserEmail(ADDRESS)).not.toBe(digestBytes(ADDRESS));
    expect(digestUserEmail(ADDRESS)).not.toBe(digestBytes(NORMALIZED));
  });

  it("is the same value every time for the same person", () => {
    const expected = digestUserEmail(NORMALIZED);
    expect(isSha256Digest(expected)).toBe(true);
    expect(digestUserEmail(ADDRESS)).toBe(expected);
    expect(digestUserEmail(`  ${ADDRESS}  `)).toBe(expected);
    expect(digestUserEmail("ADA.LOVELACE@EXAMPLE.COM")).toBe(expected);
  });

  it("distinguishes two people", () => {
    expect(digestUserEmail("a@example.com")).not.toBe(
      digestUserEmail("b@example.com"),
    );
  });

  it("yields nothing for a missing or empty address", () => {
    expect(digestUserEmail(undefined)).toBeUndefined();
    expect(digestUserEmail(null)).toBeUndefined();
    expect(digestUserEmail("")).toBeUndefined();
    expect(digestUserEmail("   ")).toBeUndefined();
  });

  it("matches the vector the store migrations reproduce in SQL", () => {
    // packages/telemetry/src/migrations/0028_tacho_events_email_digest.sql and
    // packages/database/atlas/migrations/*_tacho_sessions_email_digest.sql
    // backfill already-written rows with their own SQL SHA-256 over the same
    // domain string, NUL byte and normalized address. A backfilled row has to
    // join a newly written one, so this vector pins both sides: change the
    // domain, the normalization or the encoding here and this fails.
    expect(digestUserEmail(ADDRESS)).toBe(
      digestBytes(`oxagen:tacho:user_email:v1\0${NORMALIZED}`),
    );
  });
});

describe("the wire carries no address", () => {
  it("rejects an envelope that still names the plaintext member", () => {
    expect(() => anthropicSchema.parse({ user_email: ADDRESS })).toThrowError();
  });

  it("accepts only a sha256 digest in its place", () => {
    expect(() =>
      anthropicSchema.parse({ user_email_digest: ADDRESS }),
    ).toThrowError();
    expect(
      anthropicSchema.parse({ user_email_digest: digestUserEmail(ADDRESS) }),
    ).toEqual({ user_email_digest: digestUserEmail(ADDRESS) });
  });
});

describe("the collector digests on the host", () => {
  it("turns OTel user.email into a digest and keeps the address out of the event", () => {
    const recorder = new SessionRecorder({
      context: {
        agent: {
          agent_key: "acme.core.cc-laptop",
          fleet_id: "wrk_test",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
          host_enrollment_id: TEST_HOST,
        },
      },
      harnessSessionId: TEST_SESSION_ID,
      scope: TEST_HOST,
    });
    const events = recorder.ingestOtlp(
      otlpLog({
        "session.id": TEST_SESSION_ID,
        "user.email": ADDRESS,
        "user.id": "uid-hash",
        model: "claude-opus-4-5",
      }),
    );
    expect(events.length).toBeGreaterThan(0);
    const event = events[events.length - 1];
    expect(event?.anthropic?.user_email_digest).toBe(digestUserEmail(ADDRESS));
    for (const text of strings(event)) {
      expect(text.toLowerCase()).not.toContain(NORMALIZED);
      expect(text).not.toContain("@example.com");
    }
  });

  it("keeps user.email out of the leftover attrs map", () => {
    const { drafts } = normalizeOtlp(
      otlpLog({
        "session.id": TEST_SESSION_ID,
        "user.email": ADDRESS,
        model: "claude-opus-4-5",
      }),
    );
    for (const draft of drafts) {
      expect(Object.keys(draft.attrs)).not.toContain("user.email");
      for (const value of Object.values(draft.attrs)) {
        expect(value.toLowerCase()).not.toContain(NORMALIZED);
      }
    }
  });
});

describe("the tacho_events column set", () => {
  it("has no column that could hold a readable address", () => {
    expect(ENVELOPE_COLUMNS).not.toContain("anthropic_user_email");
    expect(TACHO_EVENT_COLUMNS).not.toContain("anthropic_user_email");
    expect(ENVELOPE_COLUMNS).toContain("anthropic_user_email_digest");
    // Any future `*_email` column would be this defect again under a new name.
    for (const column of TACHO_EVENT_COLUMNS) {
      expect(column).not.toMatch(/email$/);
    }
  });

  it("flattens the digest, not the address", () => {
    const digest = digestUserEmail(ADDRESS);
    const row = flattenEvent({
      v: "tacho/1.0",
      event_id: "01K0000000000000000000000",
      event_id_idem: `evt_${"0".repeat(64)}`,
      session_id: TEST_SESSION_ID,
      session_uuid: "340ed354-6344-4727-9f8b-1e40b5e12aa7",
      root_session_uuid: "340ed354-6344-4727-9f8b-1e40b5e12aa7",
      seq: 0,
      ts: "2026-09-08T10:06:03.000Z",
      fidelity: "sdk",
      source: "otel_log",
      kind: "model_call",
      agent: {
        agent_key: "acme.core.cc-laptop",
        fleet_id: "wrk_test",
        runtime: "claude-code",
        harness: "claude-code",
        wrapper_version: "2.1.1",
        host_enrollment_id: TEST_HOST,
      },
      anthropic: { user_email_digest: digest },
      body: {},
      prev_hash: `sha256:${"0".repeat(64)}`,
      hash: `sha256:${"1".repeat(64)}`,
    } as never);
    expect(row["anthropic_user_email_digest"]).toBe(digest);
    for (const text of strings(row)) {
      expect(text.toLowerCase()).not.toContain(NORMALIZED);
    }
  });
});
