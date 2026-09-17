/**
 * #3072, the finding that removing the column did not close.
 *
 * The check that was made was "is the address in a stored column?". The check
 * that matters is "could a reader of a full `tacho_events` dump confirm an
 * address they guess?". Those are different questions, and the answer to the
 * second was yes, twice over, while the answer to the first was no.
 *
 *   1. `sealEvent` hashes EVERY member of the event, so the per-event `hash`
 *      was a commitment to the `sha256(domain ‖ address)` the collector put in
 *      `event.anthropic`.
 *   2. `raw_source_digest` is taken over the original OTel attributes, which
 *      still held `user.email` in plaintext even though the promoted-key
 *      filter kept it out of the stored `attrs` map.
 *
 * Both are persisted. An address carries little enough entropy that a
 * commitment to one is a confirmation oracle: guess, recompute, compare. The
 * strength of sha256 is not the variable; the guessability of the input is.
 *
 * The fix is on the producer side, and it has to be. Excluding a member from
 * `hashEvent` would change the hash function itself, and every WAL entry
 * sealed before the change — whose seal covers that member — would stop
 * verifying. So the address-derived value never enters the event, and the
 * address never enters the pre-image of `raw_source_digest`. The hash function
 * is untouched, so old sealed entries still verify exactly as before.
 *
 * The property asserted here is the one that discriminates: the persisted
 * record for one address is IDENTICAL to the record for another, and to the
 * record for a session that reported no address at all. A test that merely
 * asserts the digest column is absent passes against the defective code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `event_id` is a fresh ULID per event, so two recordings differ there — and
// `hash` covers `event_id`, so it differs too — whatever the address is. Pin it,
// or the comparison measures that randomness instead of the property.
vi.mock("../src/ids", async (importOriginal) => importOriginal());
vi.mock("./ids", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ids")>();
  return { ...original, newEventId: () => "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV" };
});

import { GENESIS_CURSOR, sealEvent, verifyChain } from "./chain";
import { flattenEvent } from "./columns";
import { normalizeOtlp } from "./claude-code/otel";
import { SessionRecorder } from "./claude-code/recorder";
import { TEST_HOST, TEST_SESSION_ID, minimalSession } from "./test-helpers";

const ADA = "Ada.Lovelace@example.com";
const ALAN = "Alan.Turing@example.com";

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

function payload(email?: string) {
  return otlpLog({
    "session.id": TEST_SESSION_ID,
    ...(email === undefined ? {} : { "user.email": email }),
    "user.id": "uid-hash",
    model: "claude-opus-4-5",
  });
}

/** Every row this collector would persist for one OTLP payload. */
function persisted(email?: string) {
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
  return recorder
    .ingestOtlp(payload(email))
    .map((event) => flattenEvent(event));
}

describe("the persisted record commits to nothing about the address", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists byte-identical rows for two different addresses", () => {
    const ada = persisted(ADA);
    expect(ada.length).toBeGreaterThan(0);
    expect(persisted(ALAN)).toEqual(ada);
  });

  it("persists the same rows whether or not an address was reported", () => {
    // The strongest form. A row from a session that never had an address is
    // indistinguishable from one that did, so there is nothing to attack.
    expect(persisted(undefined)).toEqual(persisted(ADA));
  });

  it("does not commit to the address through the seal", () => {
    // `hash` covers every member, so any email-derived member anywhere in the
    // event makes the seal itself a commitment to the address.
    const hashes = (email?: string) => persisted(email).map((r) => r["hash"]);
    expect(hashes(ALAN)).toEqual(hashes(ADA));
    expect(hashes(undefined)).toEqual(hashes(ADA));
  });

  it("does not commit to the address through raw_source_digest", () => {
    const raws = (email?: string) =>
      persisted(email).map((r) => r["raw_source_digest"]);
    expect(raws(ALAN)).toEqual(raws(ADA));
    expect(raws(undefined)).toEqual(raws(ADA));
  });

  it("still verifies a chain sealed BEFORE this change, member and all", () => {
    // The interaction that makes the producer the only correct place to fix
    // this. Excluding a member from `hashEvent` would change the hash function,
    // and every WAL entry sealed earlier — whose seal covers
    // `anthropic.user_email_digest` — would stop verifying, stranding exactly
    // the entries the wire compatibility work exists to protect. Nothing about
    // hashing changed here; the collector simply stops putting the value in.
    const [genesis] = minimalSession();
    const base = { ...(genesis as unknown as Record<string, unknown>) };
    for (const key of ["hash", "prev_hash", "seq", "event_id_idem"])
      delete base[key];

    const sealed = sealEvent(
      {
        ...base,
        anthropic: { user_email_digest: `sha256:${"7".repeat(64)}` },
      } as never,
      GENESIS_CURSOR,
    );

    // A pre-change collector computed this hash over an event containing the
    // member. It still verifies, because `hashEvent` is unchanged.
    expect(verifyChain([sealed.event]).ok).toBe(true);
    expect(JSON.stringify(sealed.event)).toContain("user_email_digest");
  });

  it("carries no email-derived member into the event at all", () => {
    // The seal only had something to commit to because the collector put it
    // there. Nothing derived from the address goes into the envelope now.
    const { drafts } = normalizeOtlp(payload(ADA));
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(Object.keys(draft.standard.anthropic)).not.toContain(
        "user_email_digest",
      );
      expect(JSON.stringify(draft.standard)).not.toContain("sha256:");
    }
  });
});
