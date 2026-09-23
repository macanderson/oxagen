/**
 * The gateway mints run tokens (ADR-138). `tacho credential issue` asks the
 * daemon over the local socket, the daemon answers with a token from here,
 * and every mint is sealed on the host's own chain as a `token_issued` frame
 * that names the token's id and expiry and never the token.
 *
 * A token is minted only for a provider the gateway holds a credential for.
 * A token nothing can be spent with is not a convenience; it is a harness
 * that believes it is authenticated and finds out at its first call. The
 * refusal here tells the person what to run instead.
 */
import type { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import type { CredentialStore } from "../host/credential-store";
import { HARNESS_PROVIDER } from "../host/model-credential";
import {
  mintRunToken,
  RUN_TOKEN_PLACEMENTS,
  type RunTokenKey,
  type RunTokenPlacement,
  type RunTokenProvider,
} from "../host/run-token";
import { toProtocolTimestamp } from "../timestamp";
import {
  TACHO_CREDENTIAL_BASIS_ATTR,
  TACHO_CREDENTIAL_GATEWAY_BROKERED,
  TACHO_ENFORCEMENT_TIER_ATTR,
  TACHO_GATEWAY_TIER,
  TACHO_RUN_TOKEN_ATTR,
  isBrokerableHarness,
} from "../wire";

export interface IssueRunTokenRequest {
  harness?: unknown;
  placement?: unknown;
  ttl_ms?: unknown;
}

export interface IssuedRunToken {
  token: string;
  token_id: string;
  provider: RunTokenProvider;
  harness: string;
  placement: RunTokenPlacement;
  expires_at: string;
}

export type IssueRunTokenAnswer =
  | { status: 200; body: IssuedRunToken }
  | { status: 400 | 403; body: { error: string; code: string } };

export interface CredentialIssuerDeps {
  key: () => RunTokenKey;
  store: CredentialStore;
  host: () => {
    host_enrollment_id: string;
    host_status: string;
    expires_at: string;
  };
  hostRecorder: () => SessionRecorder;
  record: (events: readonly TachoEvent[]) => void;
  now: () => number;
  log: (line: string) => void;
}

/** The provider a harness's run token is spent at, or undefined for one with no brokered model traffic. */
export function providerForHarness(
  harness: unknown,
): RunTokenProvider | undefined {
  return typeof harness === "string" && isBrokerableHarness(harness)
    ? HARNESS_PROVIDER[harness]
    : undefined;
}

export function issueRunToken(
  input: IssueRunTokenRequest,
  deps: CredentialIssuerDeps,
): IssueRunTokenAnswer {
  const harness = typeof input.harness === "string" ? input.harness : "";
  const provider = providerForHarness(harness);
  if (provider === undefined)
    return {
      status: 400,
      body: {
        error:
          "run tokens are issued for claude-code and codex, the harnesses whose model calls the gateway routes",
        code: "harness_not_brokered",
      },
    };
  const placement: RunTokenPlacement = (
    RUN_TOKEN_PLACEMENTS as readonly unknown[]
  ).includes(input.placement)
    ? (input.placement as RunTokenPlacement)
    : "helper";
  if (
    input.ttl_ms !== undefined &&
    (typeof input.ttl_ms !== "number" ||
      !Number.isFinite(input.ttl_ms) ||
      input.ttl_ms <= 0)
  )
    return {
      status: 400,
      body: {
        error: "ttl_ms must be a positive number of milliseconds",
        code: "ttl_invalid",
      },
    };
  const ttl = input.ttl_ms;
  const host = deps.host();
  if (host.host_status !== "active")
    return {
      status: 403,
      body: {
        error: `this host is ${host.host_status} by its Oxagen operator, so no run token is issued`,
        code: `host_${host.host_status}`,
      },
    };
  let held: ReturnType<CredentialStore["read"]>;
  try {
    held = deps.store.read(provider);
  } catch (error) {
    deps.log(
      `credential issuer: cannot read custody: ${error instanceof Error ? error.message : String(error)}`,
    );
    held = undefined;
  }
  if (held === undefined)
    return {
      status: 403,
      body: {
        error: `the gateway holds no ${provider} credential in custody, so a run token would buy nothing; run \`tacho enroll\` again`,
        code: "credential_unavailable",
      },
    };
  const now = deps.now();
  const notAfter = Date.parse(host.expires_at);
  // A static token is clamped to the enrollment's expiry, so past it there is
  // nothing to mint: answered as a refusal the harness and the renewal tick
  // can read, not as a thrown mint the socket route turns into a 500.
  if (placement === "static" && Number.isFinite(notAfter) && notAfter <= now)
    return {
      status: 403,
      body: {
        error: `this host's enrollment expired at ${host.expires_at}, so no static run token is issued; run \`tacho enroll\` again`,
        code: "host_expired",
      },
    };
  const key = deps.key();
  const minted = mintRunToken({
    key,
    host: host.host_enrollment_id,
    harness,
    provider,
    placement,
    now,
    ...(ttl !== undefined ? { ttlMs: ttl } : {}),
    ...(placement === "static" && Number.isFinite(notAfter)
      ? { notAfter }
      : {}),
  });
  const expiresAt = toProtocolTimestamp(minted.claims.exp);
  try {
    deps.record([
      deps.hostRecorder().sealCollectorEvent(
        "token_issued",
        {
          token_id: minted.claims.tid,
          token_expires_at: expiresAt,
          policy_source: "bundle",
        },
        {
          attrs: {
            [TACHO_ENFORCEMENT_TIER_ATTR]: TACHO_GATEWAY_TIER,
            [TACHO_CREDENTIAL_BASIS_ATTR]: TACHO_CREDENTIAL_GATEWAY_BROKERED,
            [TACHO_RUN_TOKEN_ATTR]: minted.claims.tid,
            // Which signing key minted it, so a rotation reads on the record.
            "oxagen.run_token_key": key.id,
            "oxagen.provider": provider,
            "oxagen.harness": harness,
            "oxagen.run_token_placement": placement,
          },
        },
      ),
    ]);
  } catch (error) {
    // The mint stands: a frame that failed to seal is a gap in the record,
    // and a harness left without a credential over it would be a worse one.
    deps.log(
      `credential issuer: token minted but not recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    status: 200,
    body: {
      token: minted.token,
      token_id: minted.claims.tid,
      provider,
      harness,
      placement,
      expires_at: expiresAt,
    },
  };
}
