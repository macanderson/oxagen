/**
 * `tacho credential`: the CLI face of the credential seam (ADR-138), and the
 * enrollment and unenrollment steps that move a vendor key between a harness
 * file and the gateway's custody.
 *
 *   - `tacho credential issue --harness claude-code` is what Claude Code runs
 *     as its `apiKeyHelper`. It prints one run token and nothing else. It
 *     asks the daemon, which mints and records the issue; if the daemon does
 *     not answer it mints from the signing key on disk so a harness is never
 *     left without a credential by a daemon restart, and it says so on
 *     stderr. It refuses when the gateway holds nothing for the provider: a
 *     token nobody can spend is a harness that finds out at its first call.
 *   - `tacho credential status` says which providers are in custody, where
 *     each key came from and when, and whether each harness file points at
 *     the gateway. It never prints a secret.
 *
 * `brokerCredentials` runs at the end of `tacho enroll`, once the proxy is
 * confirmed listening: it takes each routed harness's key out of its file
 * (or from `TACHO_BROKER_ANTHROPIC_API_KEY` / `TACHO_BROKER_OPENAI_API_KEY`
 * in the enrolling shell), seals it, and points the harness at run tokens.
 * `restoreCredentials` runs first in `tacho unenroll`, before the base URL
 * comes out and long before the daemon stops, so no harness is left with a
 * run token and no gateway to spend it at.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HeldCredential } from "../host/credential-store";
import { readJsonFileIfExists } from "../host/fs";
import { type HostFile, readHostFile } from "../host/host-file";
import {
  HARNESS_PROVIDER,
  hasOrphanedModelCredential,
  type ModelCredentialHarness,
  type ModelCredentialHarnessState,
  modelCredentialBackupPath,
} from "../host/model-credential";
import {
  mintRunToken,
  readRunTokenKey,
  type RunTokenPlacement,
  type RunTokenProvider,
} from "../host/run-token";
import { TACHO_HARNESS_LABELS } from "../wire";
import type { CliDeps } from "./deps";

/** The harnesses whose model credential the gateway can broker. */
export const MODEL_CREDENTIAL_HARNESSES: ModelCredentialHarness[] = [
  "claude-code",
  "codex",
];

/**
 * How a host's model credentials are held. `brokered`: the gateway takes
 * each vendor key into custody and the harness holds a run token (the
 * default). `passthrough`: the harness keeps its own key and the proxy
 * forwards it, the way ADR-094 first built the gateway.
 */
export type CredentialMode = "brokered" | "passthrough";

export const CREDENTIAL_MODES: readonly CredentialMode[] = [
  "brokered",
  "passthrough",
];

export function parseCredentialMode(value: string | undefined): CredentialMode {
  if (value === undefined || value.length === 0) return "brokered";
  if ((CREDENTIAL_MODES as readonly string[]).includes(value))
    return value as CredentialMode;
  throw new Error(
    `unknown credential mode "${value}"; expected ${CREDENTIAL_MODES.join(" or ")}`,
  );
}

/** The enrolling shell's variable that hands a provider's key to custody. */
export function brokerEnvVar(provider: RunTokenProvider): string {
  return `TACHO_BROKER_${provider.toUpperCase()}_API_KEY`;
}

export function isCredentialHarness(
  harness: string,
): harness is ModelCredentialHarness {
  return (MODEL_CREDENTIAL_HARNESSES as readonly string[]).includes(harness);
}

interface IssueOptions {
  harness?: string;
  placement?: RunTokenPlacement;
}

export interface IssueResult {
  ok: boolean;
  token?: string;
  detail: string;
}

/**
 * Print one run token. The daemon is asked first, so the issue is recorded
 * on the host's chain; the key on disk answers when the daemon does not.
 */
export async function credentialIssue(
  options: IssueOptions,
  deps: CliDeps,
): Promise<IssueResult> {
  const harness = options.harness ?? "";
  if (!isCredentialHarness(harness))
    return {
      ok: false,
      detail: `run tokens are issued for ${MODEL_CREDENTIAL_HARNESSES.join(" and ")}; got "${harness}"`,
    };
  const provider = HARNESS_PROVIDER[harness];
  const placement: RunTokenPlacement = options.placement ?? "helper";
  const answer = await deps.daemonPost?.("/credential/issue", {
    harness,
    placement,
  });
  if (answer !== undefined) {
    let parsed: { token?: unknown; error?: unknown; code?: unknown } = {};
    try {
      parsed = JSON.parse(answer.body) as typeof parsed;
    } catch {
      parsed = {};
    }
    if (answer.status === 200 && typeof parsed.token === "string")
      return { ok: true, token: parsed.token, detail: "issued by tachod" };
    if (answer.status === 400 || answer.status === 403)
      return {
        ok: false,
        detail:
          typeof parsed.error === "string"
            ? parsed.error
            : `tachod refused to issue a run token (${answer.status})`,
      };
    // Any other answer is a daemon fault, and the key on disk still decides.
  }
  const host = readHost(deps);
  if (host === undefined)
    return {
      ok: false,
      detail: "this machine is not enrolled; run `tacho enroll`",
    };
  if (host.host_status !== "active")
    return {
      ok: false,
      detail: `this host is ${host.host_status} by its Oxagen operator, so no run token is issued`,
    };
  let held: HeldCredential | undefined;
  try {
    held = deps.credentialStore?.read(provider);
  } catch (error) {
    return {
      ok: false,
      detail: `the credential store cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (held === undefined)
    return {
      ok: false,
      detail: `the gateway holds no ${provider} credential in custody, so a run token would buy nothing; run \`tacho enroll\` again`,
    };
  const key = readRunTokenKey(deps.paths.runTokenKey);
  if (key === undefined)
    return {
      ok: false,
      detail:
        "no run token signing key on this machine; start tachod or run `tacho enroll` again",
    };
  const notAfter = Date.parse(host.expires_at);
  const minted = mintRunToken({
    key,
    host: host.host_enrollment_id,
    harness,
    provider,
    placement,
    now: deps.now(),
    ...(placement === "static" && Number.isFinite(notAfter)
      ? { notAfter }
      : {}),
  });
  return {
    ok: true,
    token: minted.token,
    detail: "issued from the signing key on disk; tachod did not answer",
  };
}

function readHost(deps: CliDeps): HostFile | undefined {
  try {
    return readHostFile(deps.paths.hostFile);
  } catch {
    return undefined;
  }
}

export interface CredentialStatusReport {
  custody: Array<{
    provider: RunTokenProvider;
    kind: string;
    source: string;
    taken_at: string;
    prefix: string;
  }>;
  harnesses: ModelCredentialHarnessState[];
}

/** What the gateway holds and where each harness gets its credential. No secrets. */
export async function credentialStatus(
  options: { json?: boolean },
  deps: CliDeps,
): Promise<CredentialStatusReport> {
  const host = readHost(deps);
  const custody = (deps.credentialStore?.status() ?? []).map((c) => ({
    provider: c.provider,
    kind: c.kind,
    source: c.source,
    taken_at: c.taken_at,
    prefix: c.prefix,
  }));
  const harnesses = (host?.harnesses ?? MODEL_CREDENTIAL_HARNESSES).filter(
    isCredentialHarness,
  );
  const state =
    deps.modelCredentials !== undefined && harnesses.length > 0
      ? (
          await deps.modelCredentials.read({
            home: deps.home,
            harnesses,
            helperCommand: deps.runtime.credentialHelperCommand,
          })
        ).harnesses
      : [];
  const report: CredentialStatusReport = { custody, harnesses: state };
  if (options.json === true) {
    deps.out(JSON.stringify(report, null, 2));
    return report;
  }
  if (custody.length === 0)
    deps.out(
      "Custody     nothing: every harness holds its own model credential and the gateway forwards it",
    );
  for (const entry of custody)
    deps.out(
      `Custody     ${entry.provider}: ${entry.kind} ${entry.prefix} from ${entry.source}, taken ${entry.taken_at}`,
    );
  for (const entry of state) deps.out(`            ${describeHarness(entry)}`);
  return report;
}

/** One line per harness for `tacho status` and `tacho credential status`. */
export function describeHarness(entry: ModelCredentialHarnessState): string {
  const label = TACHO_HARNESS_LABELS[entry.harness];
  if (entry.brokered) {
    return entry.shadowedBy !== undefined
      ? `${label}: points at the gateway's run tokens, but ${entry.shadowedBy.file} sets apiKeyHelper, and managed settings win, so it does not`
      : `${label}: holds a run token; the gateway supplies the ${HARNESS_PROVIDER[entry.harness]} credential`;
  }
  switch (entry.reason) {
    case "subscription_login":
      return `${label}: signed in with a ChatGPT login, which the gateway cannot take into custody; its own login crosses the proxy`;
    case "symlink":
      return `${label}: ${entry.file} is a symbolic link, so it was left alone; its own credential crosses the proxy`;
    case "no_file":
      return `${label}: no ${entry.file} yet; its own credential crosses the proxy`;
    default:
      return `${label}: holds its own credential, which crosses the proxy (run \`tacho enroll\` to broker it)`;
  }
}

export interface BrokerOutcome {
  /** What each harness file holds now. */
  harnesses: ModelCredentialHarnessState[];
  /** Providers whose key was taken into custody by this call. */
  taken: RunTokenProvider[];
  warnings: string[];
}

/**
 * The enrollment step: take the routed harnesses' vendor keys into custody
 * and point the harnesses at run tokens. Called once the proxy is listening.
 * Idempotent: a re-enroll takes only what a person put back since.
 */
export async function brokerCredentials(
  host: HostFile,
  harnesses: readonly string[],
  deps: CliDeps,
): Promise<BrokerOutcome> {
  const warnings: string[] = [];
  const store = deps.credentialStore;
  const contract = deps.modelCredentials;
  const targets = harnesses.filter(isCredentialHarness);
  if (store === undefined || contract === undefined || targets.length === 0)
    return { harnesses: [], taken: [], warnings };

  // Keys handed over by the enrolling shell go into custody first, so a
  // Codex host with a key in the environment and none in `auth.json` is
  // brokered too.
  const takenNow: RunTokenProvider[] = [];
  for (const harness of targets) {
    const provider = HARNESS_PROVIDER[harness];
    const fromEnv = deps.env[brokerEnvVar(provider)];
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
      store.take(
        provider,
        {
          kind: provider === "anthropic" ? "api_key" : "bearer",
          secret: fromEnv.trim(),
        },
        "enroll:env",
        deps.now(),
      );
      takenNow.push(provider);
    }
  }

  // Codex has no helper, so its token is minted here and written once. It
  // is bounded by the enrollment's expiry, and the proxy still checks host
  // status on every call, so it dies with the enrollment either way.
  const staticTokens: Partial<Record<ModelCredentialHarness, string>> = {};
  if (targets.includes("codex")) {
    // A re-enroll leaves a token that is already in place alone; only a file
    // that still holds the key, or one with no key while custody has one,
    // gets a token minted for it.
    const already = (
      await contract.read({
        home: deps.home,
        harnesses: ["codex"],
        helperCommand: deps.runtime.credentialHelperCommand,
      })
    ).harnesses[0]?.brokered;
    const hasKey =
      already !== true &&
      (store.status().some((c) => c.provider === "openai") ||
        codexFileHoldsKey(deps));
    if (hasKey) {
      const issued = await issueStatic(host, "codex", deps);
      if (issued.token !== undefined) staticTokens.codex = issued.token;
      else warnings.push(`Codex keeps its own credential: ${issued.detail}`);
    }
  }

  const state = await contract.apply({
    home: deps.home,
    harnesses: targets,
    helperCommand: deps.runtime.credentialHelperCommand,
    staticTokens,
  });
  for (const taken of state.taken) {
    store.take(
      taken.provider,
      taken.credential,
      taken.harness === "claude-code"
        ? "claude-code:settings.env"
        : "codex:auth.json",
      deps.now(),
    );
    if (!takenNow.includes(taken.provider)) takenNow.push(taken.provider);
  }
  // Codex: the key was just taken out of the file and no token was minted
  // for it yet. Mint now and apply once more.
  if (
    targets.includes("codex") &&
    staticTokens.codex === undefined &&
    state.taken.some((t) => t.harness === "codex")
  ) {
    const issued = await issueStatic(host, "codex", deps);
    if (issued.token !== undefined) {
      const again = await contract.apply({
        home: deps.home,
        harnesses: ["codex"],
        helperCommand: deps.runtime.credentialHelperCommand,
        staticTokens: { codex: issued.token },
      });
      const codex = again.harnesses[0];
      if (codex !== undefined) {
        const index = state.harnesses.findIndex((h) => h.harness === "codex");
        if (index >= 0) state.harnesses[index] = codex;
      }
    } else warnings.push(`Codex keeps its own credential: ${issued.detail}`);
  }
  // A Claude Code helper written while nothing is in custody would leave the
  // harness with a helper that refuses. Keep the helper only when the
  // gateway can back it.
  const claude = state.harnesses.find((h) => h.harness === "claude-code");
  if (
    claude !== undefined &&
    claude.brokered &&
    !store.status().some((c) => c.provider === "anthropic")
  ) {
    await contract.restore(
      {
        home: deps.home,
        harnesses: ["claude-code"],
        helperCommand: deps.runtime.credentialHelperCommand,
      },
      {},
    );
    const index = state.harnesses.indexOf(claude);
    state.harnesses[index] = {
      ...claude,
      brokered: false,
      changed: false,
      reason: "no_token",
    };
    warnings.push(
      `Claude Code keeps its own login: no Anthropic API key was found in ${claude.file} or ${brokerEnvVar("anthropic")}, so there is nothing for the gateway to take into custody. A claude.ai subscription login crosses the proxy as it is`,
    );
  }
  return { harnesses: state.harnesses, taken: takenNow, warnings };
}

function codexFileHoldsKey(deps: CliDeps): boolean {
  try {
    // The same file the writer edits: `~/.codex/auth.json` under `home`.
    const raw = readJsonFileIfExists(join(deps.home, ".codex", "auth.json"));
    return (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY ===
        "string" &&
      !(raw as { OPENAI_API_KEY: string }).OPENAI_API_KEY.startsWith("oxrt_")
    );
  } catch {
    return false;
  }
}

async function issueStatic(
  host: HostFile,
  harness: ModelCredentialHarness,
  deps: CliDeps,
): Promise<{ token?: string; detail: string }> {
  const answer = await deps.daemonPost?.("/credential/issue", {
    harness,
    placement: "static",
  });
  if (answer?.status === 200) {
    try {
      const parsed = JSON.parse(answer.body) as { token?: unknown };
      if (typeof parsed.token === "string")
        return { token: parsed.token, detail: "issued by tachod" };
    } catch {
      // Fall through to the key on disk.
    }
  }
  const key = readRunTokenKey(deps.paths.runTokenKey);
  if (key === undefined)
    return {
      detail:
        "tachod did not issue a run token and no signing key is on disk yet; run `tacho enroll` again once tachod is up",
    };
  const notAfter = Date.parse(host.expires_at);
  try {
    return {
      token: mintRunToken({
        key,
        host: host.host_enrollment_id,
        harness,
        provider: HARNESS_PROVIDER[harness],
        placement: "static",
        now: deps.now(),
        ...(Number.isFinite(notAfter) ? { notAfter } : {}),
      }).token,
      detail: "issued from the signing key on disk",
    };
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface RestoreOutcome {
  restored: string[];
  failed: string[];
}

/**
 * The unenrollment step: give every harness its key back and empty custody.
 * Sweeps every brokerable harness, enrolled or not, the way the base URL
 * restore does: a lost host.json must not leave a harness holding a run
 * token for a gateway that is about to stop.
 */
export async function restoreCredentials(
  host: Pick<HostFile, "harnesses"> | undefined,
  deps: CliDeps,
): Promise<RestoreOutcome> {
  const restored: string[] = [];
  const failed: string[] = [];
  const contract = deps.modelCredentials;
  const store = deps.credentialStore;
  if (contract === undefined) return { restored, failed };
  for (const harness of MODEL_CREDENTIAL_HARNESSES) {
    try {
      if (host !== undefined && !host.harnesses.includes(harness)) {
        const hasReceipt = existsSync(
          modelCredentialBackupPath(harness, deps.home),
        );
        if (!hasReceipt && !hasOrphanedModelCredential(harness, deps.home))
          continue;
      }
      const provider = HARNESS_PROVIDER[harness];
      let released: HeldCredential | undefined;
      try {
        released = store?.read(provider);
      } catch (error) {
        // The file keeps its run token or helper: the gateway is still
        // installed and still honours them, and stripping them here would
        // leave the harness with no credential at all while the key sits
        // in a store nobody can open. The caller stops and says so.
        failed.push(
          `the ${provider} credential in custody cannot be read (${error instanceof Error ? error.message : String(error)}); ${TACHO_HARNESS_LABELS[harness]} keeps its run token until the store is fixed`,
        );
        continue;
      }
      const state = await contract.restore(
        {
          home: deps.home,
          harnesses: [harness],
          helperCommand: deps.runtime.credentialHelperCommand,
        },
        released !== undefined ? { secrets: { [provider]: released } } : {},
      );
      for (const entry of state.harnesses)
        if (entry.changed) restored.push(entry.file);
      // The file has its key back (or never had one): custody is over.
      if (released !== undefined) store?.release(provider);
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { restored, failed };
}
