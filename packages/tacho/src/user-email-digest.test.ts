/**
 * The collector half of #3072: the address of the person behind a session must
 * not cross the wire, and no column a producer can write may carry it.
 *
 * There is no other half. An earlier round keyed the digest on the control
 * plane so the stored value would be one-way for whoever can read
 * `tacho_events`; that was withdrawn, because the server was computing a
 * stable function of a producer-chosen input and handing the answer back to
 * the principal who chose it. Nothing derived from the address is stored now,
 * in either store (ADR-084), and these tests are deliberately careful not to
 * claim the pre-image computed here would be safe to store on its own.
 */
import { describe, expect, it } from "vitest";
import { normalizeOtlp } from "./claude-code/otel";
import { SessionRecorder } from "./claude-code/recorder";
import {
  ENVELOPE_COLUMNS,
  SERVER_STAMPED_COLUMNS,
  TACHO_EVENT_COLUMNS,
  flattenEvent,
} from "./columns";
import { digestBytes, isSha256Digest } from "./digest";
import { anthropicSchema, parseTachoEvent } from "./envelope";
import { TEST_HOST, TEST_SESSION_ID, minimalSession } from "./test-helpers";

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

/** A valid event carrying the anthropic block a test wants to exercise. */
function eventWithAnthropic(anthropic: Record<string, string>) {
  const [genesis] = minimalSession();
  const rest = { ...(genesis as unknown as Record<string, unknown>) };
  delete rest["hash"];
  return parseTachoEvent({
    ...rest,
    anthropic,
    hash: `sha256:${"1".repeat(64)}`,
  });
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

describe("no address-derived value is computed at all", () => {
  it("has no digestUserEmail to call", async () => {
    // It existed to keep the address off the wire by hashing it on the host.
    // That was necessary and not sufficient: `sealEvent` hashes every member,
    // so shipping the hash made the persisted seal a commitment to a
    // low-entropy value, and a commitment to a guessable input is a
    // confirmation oracle. Nothing derived from the address is computed,
    // shipped or stored now — see address-commitments.test.ts for the
    // property. This test exists so the function cannot come back unnoticed.
    const digest = await import("./digest");
    expect(Object.keys(digest)).not.toContain("digestUserEmail");
  });

  it("would still be reproducible by a guesser, which is why it is gone", () => {
    // The original finding, kept because the reasoning is what generalises:
    // the domain separator is public, so anyone holding the value and a
    // candidate address recomputes it and compares. The strength of sha256 is
    // not the variable; the guessability of the input is.
    const whatAGuesserComputes = digestBytes(
      `oxagen:tacho:user_email:v1\0${NORMALIZED}`,
    );
    expect(isSha256Digest(whatAGuesserComputes)).toBe(true);
  });
});

describe("the wire", () => {
  it("still accepts the legacy plaintext member, so installed collectors keep reporting", () => {
    // Removing `user_email` from this strict schema rejected the WHOLE ingest
    // batch for any host that had not upgraded, and left sealed WAL entries
    // permanently unsendable. The wire version is still tacho/1.0, so a host
    // has no signal to upgrade on.
    expect(anthropicSchema.parse({ user_email: ADDRESS })).toEqual({
      user_email: ADDRESS,
    });
  });

  it("accepts the host-side pre-image an installed collector still sends", () => {
    // A collector from the previous round computes this itself. The control
    // plane must keep accepting it — refusing would fail the whole batch and
    // strand sealed WAL entries — and stores nothing derived from it.
    const digest = `sha256:${"7".repeat(64)}`;
    expect(anthropicSchema.parse({ user_email_digest: digest })).toEqual({
      user_email_digest: digest,
    });
  });

  it("still refuses a pre-image that is not a sha256 digest", () => {
    expect(() =>
      anthropicSchema.parse({ user_email_digest: ADDRESS }),
    ).toThrowError();
  });

  it("parses a whole legacy event carrying the address", () => {
    expect(
      eventWithAnthropic({ user_email: ADDRESS }).anthropic?.user_email,
    ).toBe(ADDRESS);
  });
});

describe("the collector drops the address on the host", () => {
  it("puts neither the address nor anything derived from it in the event", () => {
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
    expect(event?.anthropic?.user_email_digest).toBeUndefined();
    expect(event?.anthropic?.user_email).toBeUndefined();
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
  it("has no person column at all, stamped or otherwise", () => {
    // An earlier round stamped a keyed digest here. That was an oracle: a host
    // key may ingest and an org Member may read the session back, so a stable
    // value computed from the producer-chosen `anthropic` block could be
    // matched against a colleague's row by submitting guesses. The session's
    // person is `initiating_principal_id`, which this deployment issues.
    for (const set of [
      ENVELOPE_COLUMNS,
      TACHO_EVENT_COLUMNS,
      SERVER_STAMPED_COLUMNS,
    ]) {
      expect(set).not.toContain("anthropic_user_email_digest");
      expect(set).not.toContain("anthropic_user_email");
    }
  });

  it("has no column that could hold a readable address", () => {
    expect(ENVELOPE_COLUMNS).not.toContain("anthropic_user_email");
    expect(TACHO_EVENT_COLUMNS).not.toContain("anthropic_user_email");
    // Any future `*_email` column would be this defect again under a new name.
    for (const column of TACHO_EVENT_COLUMNS) {
      expect(column).not.toMatch(/email$/);
    }
  });

  it("flattens neither the address nor the pre-image", () => {
    const row = flattenEvent(
      eventWithAnthropic({
        user_email: ADDRESS,
        user_email_digest: `sha256:${"7".repeat(64)}`,
      }),
    );
    expect(row["anthropic_user_email"]).toBeUndefined();
    expect(row["anthropic_user_email_digest"]).toBeUndefined();
    for (const text of strings(row)) {
      expect(text.toLowerCase()).not.toContain(NORMALIZED);
    }
  });
});
