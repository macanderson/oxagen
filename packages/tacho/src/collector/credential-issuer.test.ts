/**
 * The daemon's run token mint (ADR-138) on its own: a real recorder on its
 * own chain, a real custody store in a scratch directory, a real signing
 * key. What the proxy test proves end to end, this file proves branch by
 * branch: every refusal, every clamp, and the one failure the mint survives.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import {
  type CredentialStore,
  openCredentialStore,
} from "../host/credential-store";
import {
  generateRunTokenKey,
  peekRunTokenClaims,
  RUN_TOKEN_MAX_TTL_MS,
  RUN_TOKEN_STATIC_MAX_TTL_MS,
  type RunTokenKey,
  verifyRunToken,
} from "../host/run-token";
import { TACHO_RUN_TOKEN_ATTR } from "../wire";
import {
  type CredentialIssuerDeps,
  issueRunToken,
  providerForHarness,
} from "./credential-issuer";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const HOST = "tch_0123456789abcdefghjkmn";
const ENROLLMENT_ENDS = "2026-09-25T12:00:00.000Z";
const SECRET = "sk-ant-api03-FAKE-IN-CUSTODY-issuer-0001";

let dir: string;
let store: CredentialStore;
let key: RunTokenKey;
let recorded: TachoEvent[];
let log: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "credential-issuer-"));
  store = openCredentialStore({
    file: join(dir, "credentials.json"),
    key: join(dir, "credentials.key"),
  });
  key = generateRunTokenKey();
  recorded = [];
  log = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function recorder(): SessionRecorder {
  return new SessionRecorder({
    context: {
      agent: {
        agent_key: "acme.core.cc-laptop",
        fleet_id: "wrk_test",
        runtime: "claude-code",
        harness: "claude-code",
        wrapper_version: "2.1.1",
        host_enrollment_id: HOST,
      },
    },
    harnessSessionId: "host",
    scope: HOST,
  });
}

function deps(
  overrides: Partial<CredentialIssuerDeps> = {},
): CredentialIssuerDeps {
  const hostRecorder = recorder();
  return {
    key: () => key,
    store,
    host: () => ({
      host_enrollment_id: HOST,
      host_status: "active",
      expires_at: ENROLLMENT_ENDS,
    }),
    hostRecorder: () => hostRecorder,
    record: (events) => {
      recorded.push(...events);
    },
    now: () => NOW,
    log: (line) => log.push(line),
    ...overrides,
  };
}

function holdAnthropic(): void {
  store.take(
    "anthropic",
    { kind: "api_key", secret: SECRET },
    "claude-code:settings.env",
    NOW,
  );
}

describe("issuing a run token", () => {
  it("mints for a brokered harness, records the id and expiry on the host's chain, and never the token", () => {
    holdAnthropic();
    const answer = issueRunToken({ harness: "claude-code" }, deps());
    expect(answer.status).toBe(200);
    if (answer.status !== 200) throw new Error("unreachable");
    expect(answer.body).toMatchObject({
      provider: "anthropic",
      harness: "claude-code",
      placement: "helper",
      expires_at: new Date(NOW + RUN_TOKEN_MAX_TTL_MS).toISOString(),
    });
    expect(
      verifyRunToken(answer.body.token, {
        key,
        host: HOST,
        provider: "anthropic",
        now: NOW,
      }),
    ).toMatchObject({ ok: true, claims: { tid: answer.body.token_id } });
    expect(recorded).toHaveLength(1);
    const frame = recorded[0]!;
    expect(frame.kind).toBe("token_issued");
    expect(frame.body).toMatchObject({
      token_id: answer.body.token_id,
      token_expires_at: answer.body.expires_at,
    });
    expect(frame.attrs[TACHO_RUN_TOKEN_ATTR]).toBe(answer.body.token_id);
    expect(frame.attrs["oxagen.run_token_placement"]).toBe("helper");
    // The key that signed it is named by id, so a rotation reads on the
    // record; the key itself, like the token, is nowhere.
    expect(frame.attrs["oxagen.run_token_key"]).toBe(key.id);
    expect(JSON.stringify(recorded)).not.toContain(key.bytes.toString("hex"));
    const written = JSON.stringify(recorded) + log.join("\n");
    expect(written).not.toContain(answer.body.token);
    expect(written).not.toContain(SECRET);
  });

  it("refuses a harness whose model calls the gateway does not route, before reading anything", () => {
    for (const harness of ["stella", "cursor", "", 7, undefined])
      expect(issueRunToken({ harness }, deps())).toEqual({
        status: 400,
        body: {
          error: expect.stringContaining("claude-code and codex"),
          code: "harness_not_brokered",
        },
      });
    expect(providerForHarness("codex")).toBe("openai");
    expect(providerForHarness("claude-desktop")).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it("refuses a host that is not active, naming the status, and mints nothing", () => {
    holdAnthropic();
    for (const status of ["paused", "suspended", "revoked"]) {
      const answer = issueRunToken(
        { harness: "claude-code" },
        deps({
          host: () => ({
            host_enrollment_id: HOST,
            host_status: status,
            expires_at: ENROLLMENT_ENDS,
          }),
        }),
      );
      expect(answer).toEqual({
        status: 403,
        body: {
          error: expect.stringContaining(`this host is ${status}`),
          code: `host_${status}`,
        },
      });
    }
    expect(recorded).toEqual([]);
  });

  it("refuses when nothing is in custody for the provider, and when the store cannot be read", () => {
    // Anthropic held, Codex asked: a token for OpenAI would buy nothing.
    holdAnthropic();
    expect(issueRunToken({ harness: "codex" }, deps())).toEqual({
      status: 403,
      body: {
        error: expect.stringContaining("holds no openai credential"),
        code: "credential_unavailable",
      },
    });
    // The store file damaged: the same refusal, and the fault is logged
    // rather than mistaken for an empty store in silence.
    writeFileSync(join(dir, "credentials.json"), "{ not a store");
    expect(issueRunToken({ harness: "claude-code" }, deps())).toMatchObject({
      status: 403,
      body: { code: "credential_unavailable" },
    });
    expect(log.some((l) => l.includes("cannot read custody"))).toBe(true);
    expect(recorded).toEqual([]);
  });

  it("honours a shorter ttl, refuses one that is not a positive number, and reads an unknown placement as helper", () => {
    holdAnthropic();
    const shorter = issueRunToken(
      { harness: "claude-code", ttl_ms: 60_000, placement: "sticky" },
      deps(),
    );
    expect(shorter.body).toMatchObject({
      placement: "helper",
      expires_at: new Date(NOW + 60_000).toISOString(),
    });
    const longer = issueRunToken(
      { harness: "claude-code", ttl_ms: 24 * 60 * 60_000 },
      deps(),
    );
    expect((longer.body as { expires_at: string }).expires_at).toBe(
      new Date(NOW + RUN_TOKEN_MAX_TTL_MS).toISOString(),
    );
    // A ttl that is not a positive number is the caller's error and is told
    // so, before the host or the store is consulted.
    for (const ttl_ms of ["soon", 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(issueRunToken({ harness: "claude-code", ttl_ms }, deps())).toEqual(
        {
          status: 400,
          body: {
            error: expect.stringContaining("positive number"),
            code: "ttl_invalid",
          },
        },
      );
    expect(recorded.map((e) => e.kind)).toEqual([
      "token_issued",
      "token_issued",
    ]);
  });

  it("bounds a static token by the enrollment's expiry, or by the static ceiling when that does not parse", () => {
    store.take(
      "openai",
      { kind: "bearer", secret: "sk-proj-FAKE" },
      "codex:auth.json",
      NOW,
    );
    const bounded = issueRunToken(
      { harness: "codex", placement: "static" },
      deps(),
    );
    expect(bounded.body).toMatchObject({
      placement: "static",
      provider: "openai",
      expires_at: ENROLLMENT_ENDS,
    });
    expect(
      peekRunTokenClaims((bounded.body as { token: string }).token),
    ).toMatchObject({ placement: "static", exp: Date.parse(ENROLLMENT_ENDS) });
    const open = issueRunToken(
      { harness: "codex", placement: "static" },
      deps({
        host: () => ({
          host_enrollment_id: HOST,
          host_status: "active",
          expires_at: "never",
        }),
      }),
    );
    expect((open.body as { expires_at: string }).expires_at).toBe(
      new Date(NOW + RUN_TOKEN_STATIC_MAX_TTL_MS).toISOString(),
    );
    // A helper token is never bounded by the enrollment: it is shorter.
    const helper = issueRunToken({ harness: "codex" }, deps());
    expect((helper.body as { expires_at: string }).expires_at).toBe(
      new Date(NOW + RUN_TOKEN_MAX_TTL_MS).toISOString(),
    );
  });

  it("lets the mint stand when the frame cannot be recorded, and says so in the log", () => {
    holdAnthropic();
    const answer = issueRunToken(
      { harness: "claude-code" },
      deps({
        record: () => {
          throw new Error("wal is read-only");
        },
      }),
    );
    expect(answer.status).toBe(200);
    expect(
      verifyRunToken((answer.body as { token: string }).token, {
        key,
        host: HOST,
        provider: "anthropic",
        now: NOW,
      }).ok,
    ).toBe(true);
    expect(log).toEqual([
      expect.stringContaining(
        "token minted but not recorded: wal is read-only",
      ),
    ]);
  });
});
