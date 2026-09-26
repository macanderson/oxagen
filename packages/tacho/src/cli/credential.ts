/**
 * `tacho credential`: the CLI face of the credential seam (ADR-143), and the
 * enrollment and unenrollment steps that move a vendor key between a harness
 * file and the gateway's custody.
 *
 *   - `tacho credential issue --harness claude-code` is what Claude Code runs
 *     as its `apiKeyHelper`. It prints one run token and nothing else. It
 *     asks the daemon, which mints and records the issue. When the daemon
 *     does not answer it prints no token and says why on stderr: the proxy
 *     is the daemon, so a token minted around it would buy a model call that
 *     cannot happen anyway. It refuses when the gateway holds nothing for
 *     the provider: a token nobody can spend is a harness that finds out at
 *     its first call.
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
import { dirname } from "node:path";
import type {
  CredentialSource,
  HeldCredential,
} from "../host/credential-store";
import { type HostFile, readHostFile } from "../host/host-file";
import {
  HARNESS_PROVIDER,
  hasOrphanedModelCredential,
  type ModelCredentialHarness,
  type ModelCredentialHarnessState,
  type ModelCredentialState,
  modelCredentialBackupPath,
  readCodexApiKeyMember,
  staticTokenStillGood,
} from "../host/model-credential";

export {
  STATIC_TOKEN_RENEW_WINDOW_MS,
  staticTokenStillGood,
} from "../host/model-credential";
import type { RunTokenPlacement, RunTokenProvider } from "../host/run-token";
import {
  BROKERABLE_HARNESSES,
  isBrokerableHarness,
  TACHO_HARNESS_LABELS,
} from "../wire";
import type { CliDeps } from "./deps";

/**
 * Claude Code's and Codex's directories as this process's paths resolved
 * them, which is where the hooks went. The credential and base URL files
 * sit beside them, so a lookup that resolved its own directories could
 * read a different file than the one enroll wrote.
 */
export function harnessDirsOf(deps: Pick<CliDeps, "paths">): {
  claudeConfigDir: string;
  codexHome: string;
} {
  return {
    claudeConfigDir: dirname(deps.paths.claudeSettings),
    codexHome: dirname(deps.paths.codexHooks),
  };
}

/** The harnesses whose model credential the gateway can broker, off the route table. */
export const MODEL_CREDENTIAL_HARNESSES: ModelCredentialHarness[] = [
  ...BROKERABLE_HARNESSES,
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
  return isBrokerableHarness(harness);
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
 * Print one run token. Only the daemon mints, so every token the harness ever
 * holds is a `token_issued` frame on the host's chain. When the daemon does
 * not answer, no token is printed: the proxy is the daemon, so a token minted
 * around it would buy a model call that cannot happen anyway, and the harness
 * is told why instead.
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
  const placement: RunTokenPlacement = options.placement ?? "helper";
  const answer = await deps.daemonPost?.("/credential/issue", {
    harness,
    placement,
  });
  if (answer === undefined) {
    const host = readHost(deps);
    return {
      ok: false,
      detail:
        host === undefined
          ? "this machine is not enrolled; run `tacho enroll`"
          : "tachod is not answering, so no run token is issued: the gateway it would be spent at is down. Run `tacho status`",
    };
  }
  const issued = parseIssueAnswer(answer);
  return issued.token !== undefined
    ? { ok: true, token: issued.token, detail: issued.detail }
    : { ok: false, detail: issued.detail };
}

/** The daemon's answer to `/credential/issue`: the token, or why there is none. */
export function parseIssueAnswer(answer: { status: number; body: string }): {
  token?: string;
  detail: string;
} {
  let parsed: { token?: unknown; error?: unknown } = {};
  try {
    parsed = JSON.parse(answer.body) as typeof parsed;
  } catch {
    parsed = {};
  }
  if (answer.status === 200 && typeof parsed.token === "string")
    return { token: parsed.token, detail: "issued by tachod" };
  return {
    detail:
      typeof parsed.error === "string"
        ? parsed.error
        : answer.status === 200
          ? "tachod answered without a run token"
          : `tachod refused to issue a run token (${answer.status})`,
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
    case "two_credentials":
      return `${label}: ${entry.file} sets both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN in env, and the gateway holds one ${HARNESS_PROVIDER[entry.harness]} credential; remove one and run \`tacho enroll\` again. Its own credential crosses the proxy`;
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
 *
 * Seal first, then edit. The keys are read off the files (`peek`) and out of
 * the enrolling shell, sealed in the store, and only then are the files
 * rewritten, so a crash or a store fault between the two leaves every key
 * where it was and never nowhere. Idempotent: a re-enroll takes only what a
 * person put back since, and re-mints Codex's token only when the one in
 * place no longer verifies for this enrollment or is near its expiry.
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
  const helperCommand = deps.runtime.credentialHelperCommand;

  // 1. What there is to take: the files first, the shell second. A key in
  // the file is the one the harness is using today, so it wins over one
  // exported for the occasion.
  const offered = new Map<
    RunTokenProvider,
    { credential: HeldCredential; source: CredentialSource }
  >();
  for (const taken of await contract.peek({
    home: deps.home,
    harnesses: targets,
    helperCommand,
  })) {
    offered.set(taken.provider, {
      credential: taken.credential,
      source:
        taken.harness === "claude-code"
          ? "claude-code:settings.env"
          : "codex:auth.json",
    });
  }
  for (const harness of targets) {
    const provider = HARNESS_PROVIDER[harness];
    const fromEnv = deps.env[brokerEnvVar(provider)];
    if (
      !offered.has(provider) &&
      typeof fromEnv === "string" &&
      fromEnv.trim().length > 0
    )
      offered.set(provider, {
        credential: {
          kind: provider === "anthropic" ? "api_key" : "bearer",
          secret: fromEnv.trim(),
        },
        source: "enroll:env",
      });
  }

  // 2. Seal. Nothing has been written to a harness file yet, so a store that
  // refuses leaves the machine exactly as it was.
  const takenNow: RunTokenProvider[] = [];
  for (const [provider, offer] of offered) {
    store.take(provider, offer.credential, offer.source, deps.now());
    takenNow.push(provider);
  }

  // 3. Codex's static token, minted by the daemon so the issue is on the
  // record, only when custody can back it and the one in place will not do.
  const staticTokens: Partial<Record<ModelCredentialHarness, string>> = {};
  if (targets.includes("codex") && store.has("openai")) {
    const before = (
      await contract.read({ home: deps.home, harnesses: ["codex"] })
    ).harnesses[0];
    if (before?.reason !== "subscription_login") {
      const current = readCodexApiKeyMember(deps.home, harnessDirsOf(deps));
      if (
        !staticTokenStillGood(current, host, deps.paths.runTokenKey, deps.now())
      ) {
        const issued = await issueStatic("codex", deps);
        if (issued.token !== undefined) staticTokens.codex = issued.token;
        else warnings.push(`Codex keeps its own credential: ${issued.detail}`);
      }
    }
  }

  // 4. Edit the files. Anything apply reports as taken was already sealed
  // above; a value that appeared between peek and apply is sealed now. If
  // the edit fails, custody taken by this call is given up again: the keys
  // are still in the files, and a provider in custody whose harness was not
  // pointed at the gateway would have every call refused as foreign.
  let state: ModelCredentialState;
  try {
    state = await contract.apply({
      home: deps.home,
      harnesses: targets,
      helperCommand,
      staticTokens,
    });
  } catch (error) {
    for (const provider of takenNow) store.release(provider);
    throw error;
  }
  for (const taken of state.taken) {
    if (offered.has(taken.provider)) continue;
    store.take(
      taken.provider,
      taken.credential,
      taken.harness === "claude-code"
        ? "claude-code:settings.env"
        : "codex:auth.json",
      deps.now(),
    );
    takenNow.push(taken.provider);
  }

  // 5. Reconcile. A harness the files could not point at the gateway must
  // not have its key in custody either, or every call it makes is refused as
  // a foreign credential. The key goes back where it came from.
  for (const entry of state.harnesses) {
    const provider = HARNESS_PROVIDER[entry.harness];
    if (entry.brokered) {
      if (!store.has(provider)) {
        // A helper with nothing behind it would be refused on every call.
        await contract.restore(
          { home: deps.home, harnesses: [entry.harness], helperCommand },
          {},
        );
        const index = state.harnesses.indexOf(entry);
        state.harnesses[index] = {
          ...entry,
          brokered: false,
          changed: false,
          reason: "no_token",
        };
        warnings.push(
          `${TACHO_HARNESS_LABELS[entry.harness]} keeps its own login: no ${provider} key was found in ${entry.file} or ${brokerEnvVar(provider)}, so there is nothing for the gateway to take into custody. A subscription login crosses the proxy as it is`,
        );
      }
      continue;
    }
    if (store.has(provider) && takenNow.includes(provider)) {
      const released = store.release(provider);
      const index = takenNow.indexOf(provider);
      if (index >= 0) takenNow.splice(index, 1);
      const offer = offered.get(provider);
      if (offer?.source === "enroll:env" || released === undefined) continue;
      // The key came out of the file by peek and the file was not rewritten,
      // so it is still there; custody was the only copy to drop.
      warnings.push(
        `${TACHO_HARNESS_LABELS[entry.harness]} keeps its own credential (${entry.reason ?? "not brokered"}), so its ${provider} key was not taken into custody`,
      );
    }
  }
  return { harnesses: state.harnesses, taken: takenNow, warnings };
}

/** A static token for Codex, from the daemon and nowhere else. */
async function issueStatic(
  harness: ModelCredentialHarness,
  deps: CliDeps,
): Promise<{ token?: string; detail: string }> {
  const answer = await deps.daemonPost?.("/credential/issue", {
    harness,
    placement: "static",
  });
  if (answer === undefined)
    return {
      detail:
        "tachod did not answer, so no run token was issued; run `tacho enroll` again once tachod is up",
    };
  return parseIssueAnswer(answer);
}

export interface RestoreOutcome {
  restored: string[];
  failed: string[];
  warnings: string[];
  /**
   * The store could not be opened for at least one provider. On unenroll the
   * caller then leaves the sealed files where they are instead of shredding
   * them, so a person who repairs the key file can still recover the key.
   */
  custodyUnreadable: boolean;
}

/**
 * How a restore treats a store it cannot open. `unenroll` strips the token
 * and the helper anyway and warns, because the gateway they work at is about
 * to be removed and a refusing helper is worse than a missing key.
 * `passthrough` keeps them and fails, because the gateway stays and the key
 * may yet be recovered.
 */
export type RestoreMode = "unenroll" | "passthrough";

/**
 * The unenrollment step: give every harness its key back and empty custody.
 * Sweeps every brokerable harness, enrolled or not, the way the base URL
 * restore does: a lost host.json must not leave a harness holding a run
 * token for a gateway that is about to stop. Custody is released only once
 * the file says the key landed; a key with nowhere to go stays in custody
 * under `passthrough` and is discarded with a warning under `unenroll`.
 *
 * `only` limits the sweep to those harnesses, so `enroll` can give one
 * harness its key back and leave the others brokered.
 */
export async function restoreCredentials(
  host: Pick<HostFile, "harnesses"> | undefined,
  deps: CliDeps,
  mode: RestoreMode = "unenroll",
  only?: readonly string[],
): Promise<RestoreOutcome> {
  const restored: string[] = [];
  const failed: string[] = [];
  const warnings: string[] = [];
  let custodyUnreadable = false;
  const contract = deps.modelCredentials;
  const store = deps.credentialStore;
  if (contract === undefined)
    return { restored, failed, warnings, custodyUnreadable };
  const helperCommand = deps.runtime.credentialHelperCommand;
  for (const harness of MODEL_CREDENTIAL_HARNESSES) {
    if (only !== undefined && !only.includes(harness)) continue;
    try {
      if (host !== undefined && !host.harnesses.includes(harness)) {
        const dirs = harnessDirsOf(deps);
        const hasReceipt = existsSync(
          modelCredentialBackupPath(harness, deps.home, dirs),
        );
        if (
          !hasReceipt &&
          !hasOrphanedModelCredential(harness, deps.home, dirs)
        )
          continue;
      }
      const provider = HARNESS_PROVIDER[harness];
      const label = TACHO_HARNESS_LABELS[harness];
      let released: HeldCredential | undefined;
      let unreadable: string | undefined;
      try {
        released = store?.read(provider);
      } catch (error) {
        unreadable = error instanceof Error ? error.message : String(error);
      }
      if (unreadable !== undefined) {
        custodyUnreadable = true;
        if (mode === "passthrough") {
          failed.push(
            `the ${provider} credential in custody cannot be read (${unreadable}); ${label} keeps its run token until the store is fixed`,
          );
          continue;
        }
        warnings.push(
          `the ${provider} credential in custody cannot be read (${unreadable}). ${label}'s run token was taken out anyway, since the gateway it worked at is being removed; set the ${provider} key in ${label} by hand. The sealed store is left at ${deps.paths.credentials} in case the key file can be repaired`,
        );
      }
      const state = await contract.restore(
        { home: deps.home, harnesses: [harness], helperCommand },
        released !== undefined ? { secrets: { [provider]: released } } : {},
      );
      for (const entry of state.harnesses) {
        if (entry.changed) restored.push(entry.file);
        if (released === undefined) continue;
        if (entry.secretRestored === true) {
          store?.release(provider);
          continue;
        }
        if (mode === "unenroll") {
          store?.release(provider);
          warnings.push(
            `${entry.file} already holds a ${provider} credential of its own, so the older one the gateway held was not written back and is discarded with the store`,
          );
        } else {
          warnings.push(
            `${entry.file} already holds a ${provider} credential of its own, so the one the gateway holds stays in custody; run \`tacho credential status\` to see it`,
          );
        }
      }
    } catch (error) {
      failed.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { restored, failed, warnings, custodyUnreadable };
}
