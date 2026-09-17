/**
 * The collector half of #3072: the address of the person behind a session must
 * not cross the wire, and no column a producer can write may carry it.
 *
 * The other half — making the STORED value one-way for whoever can read
 * `tacho_events` — is keying, and it lives on the control plane:
 * `packages/handlers/src/lib/tacho-user-email-digest.test.ts`. These tests are
 * deliberately careful not to claim the pre-image computed here is safe to
 * store on its own.
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
import { digestBytes, digestUserEmail, isSha256Digest } from "./digest";
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

describe("digestUserEmail is a pre-image, not a stored value", () => {
  it("reduces the same person to the same value", () => {
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

  it("is reproducible by anyone who guesses the address, which is why the stored value is keyed", () => {
    // The finding on the first draft of #3072, pinned so the claim cannot
    // quietly come back: the domain separator is public, so a guesser
    // reproduces this exactly. Nothing may store this value as though it were
    // one-way — see the server-stamped column below.
    const whatAGuesserComputes = digestBytes(
      `oxagen:tacho:user_email:v1\0${NORMALIZED}`,
    );
    expect(digestUserEmail(ADDRESS)).toBe(whatAGuesserComputes);
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

  it("accepts the host-side pre-image a current collector sends", () => {
    const digest = digestUserEmail(ADDRESS);
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

describe("the collector hashes on the host", () => {
  it("turns OTel user.email into a pre-image and keeps the address out of the event", () => {
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
  it("lets no producer write the person column", () => {
    // Server-stamped, like org_id: the stored value is keyed with a secret the
    // producer does not hold, so a producer-supplied one would be either
    // forged or reversible.
    expect(SERVER_STAMPED_COLUMNS).toContain("anthropic_user_email_digest");
    expect(ENVELOPE_COLUMNS).not.toContain("anthropic_user_email_digest");
    expect(TACHO_EVENT_COLUMNS).not.toContain("anthropic_user_email_digest");
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
        user_email_digest: digestUserEmail(ADDRESS) as string,
      }),
    );
    expect(row["anthropic_user_email"]).toBeUndefined();
    expect(row["anthropic_user_email_digest"]).toBeUndefined();
    for (const text of strings(row)) {
      expect(text.toLowerCase()).not.toContain(NORMALIZED);
    }
  });
});
