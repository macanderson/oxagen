/**
 * Every way a call to a local server stops, with the fix a person makes.
 *
 * The first four rows are the spec's Local servers table, word for word
 * (mcp-studio-spec, Local servers). The rest are the checks the local gateway
 * runs on each envelope and launch, written the same way: what happened, then
 * what to do.
 *
 * The cloud gateway imports this table too, through `@oxagen/tacho/local-servers`,
 * so a machine outside the group reads the same sentence on both sides.
 */

export const LOCAL_SERVER_ERROR_CODES = [
  "not_in_group",
  "digest_mismatch",
  "cloud_unreachable",
  "missing_variable",
  "digest_unavailable",
  "envelope_invalid",
  "envelope_expired",
  "envelope_replayed",
  "wrong_machine",
  "arguments_mismatch",
  "launch_mismatch",
  "server_failed",
  "deadline",
] as const;
export type LocalServerErrorCode = (typeof LOCAL_SERVER_ERROR_CODES)[number];

/** A refusal or failure, as the agent and the person who fixes it read it. */
export interface LocalServerRefusal {
  code: LocalServerErrorCode;
  /** What happened. */
  message: string;
  /** What to do. */
  fix: string;
}

export class LocalServerError extends Error implements LocalServerRefusal {
  readonly code: LocalServerErrorCode;
  readonly fix: string;

  constructor(refusal: LocalServerRefusal) {
    super(refusal.message);
    this.name = "LocalServerError";
    this.code = refusal.code;
    this.fix = refusal.fix;
  }

  refusal(): LocalServerRefusal {
    return { code: this.code, message: this.message, fix: this.fix };
  }
}

/** The groups a server names, joined for the spec's sentence: dev-laptops, or dev-laptops or ci-runners. */
function groupList(groups: readonly string[]): string {
  return groups.length === 0 ? "(none)" : groups.join(" or ");
}

export function notInGroup(groups: readonly string[]): LocalServerRefusal {
  return {
    code: "not_in_group",
    message: `This machine is not in group ${groupList(groups)}.`,
    fix: "Ask a workspace admin to add it.",
  };
}

export function digestMismatch(): LocalServerRefusal {
  return {
    code: "digest_mismatch",
    message: "The package digest does not match the lock.",
    fix: "Reinstall the locked version, or run the sync if the package changed on purpose.",
  };
}

export function cloudUnreachable(): LocalServerRefusal {
  return {
    code: "cloud_unreachable",
    message: "Oxagen's cloud gateway cannot be reached.",
    fix: "Local tools stay off until it is back. Check the network, then retry.",
  };
}

export function missingVariable(name: string): LocalServerRefusal {
  return {
    code: "missing_variable",
    message: `The package needs ${name}, and this machine does not set it.`,
    fix: "Set it where the local gateway starts, then retry.",
  };
}

export function digestUnavailable(what: string, reason: string): LocalServerRefusal {
  return {
    code: "digest_unavailable",
    message: `The local gateway could not compute the digest of ${what}: ${reason}.`,
    fix: "Check the network and that the locked version is installed, then retry.",
  };
}

export function envelopeInvalid(reason: string): LocalServerRefusal {
  return {
    code: "envelope_invalid",
    message: `The call's envelope does not verify: ${reason}.`,
    fix: "Enroll this machine again if Oxagen rotated its signing key, then retry.",
  };
}

export function envelopeExpired(expiresAt: string): LocalServerRefusal {
  return {
    code: "envelope_expired",
    message: `The call's envelope expired at ${expiresAt}.`,
    fix: "Check that this machine's clock is correct, then retry.",
  };
}

export function envelopeReplayed(): LocalServerRefusal {
  return {
    code: "envelope_replayed",
    message: "The local gateway already ran a call with this envelope's nonce.",
    fix: "Retry the call. The cloud gateway signs each call with a new nonce.",
  };
}

export function wrongMachine(machine: string): LocalServerRefusal {
  return {
    code: "wrong_machine",
    message: `The call's envelope is for machine ${machine}, not this one.`,
    fix: "Retry the call. The cloud gateway sends it to the machine the envelope names.",
  };
}

export function argumentsMismatch(): LocalServerRefusal {
  return {
    code: "arguments_mismatch",
    message: "The call's arguments do not hash to the envelope's arguments_hash.",
    fix: "Retry the call. The local gateway runs only the arguments the cloud gateway signed.",
  };
}

export function launchMismatch(reason: string): LocalServerRefusal {
  return {
    code: "launch_mismatch",
    message: `The launch does not match the lock: ${reason}.`,
    fix: "Run the sync so the lock and the server match, then retry.",
  };
}

export function serverFailed(server: string, reason: string): LocalServerRefusal {
  return {
    code: "server_failed",
    message: `The local server ${server} failed: ${reason}.`,
    fix: "Check that its command runs on this machine, then retry.",
  };
}

export function deadlinePassed(server: string, deadlineMs: number): LocalServerRefusal {
  return {
    code: "deadline",
    message: `The local server ${server} did not answer within ${deadlineMs} ms.`,
    fix: "Raise deadline_ms for the tool in tools.toml, or check why the server is slow.",
  };
}

/** The text an agent reads: what happened, then what to do. */
export function refusalText(refusal: LocalServerRefusal): string {
  return `${refusal.message} ${refusal.fix}`;
}
