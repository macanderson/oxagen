// credentials.ts: the customer-held credential the relay adds to a request.
//
// An envelope may name a credential. The secret never leaves the customer's
// network: it lives in the relay's own environment, and the relay adds it
// after it has checked the envelope, so the signed headers never hold it.
// Oxagen allows an envelope to name one only on the Enterprise plan.
//
// Each credential reads variables named after it. For the credential
// billing-api:
//
// - bearer: RELAY_CREDENTIAL_BILLING_API_TOKEN
// - basic: RELAY_CREDENTIAL_BILLING_API_USERNAME and RELAY_CREDENTIAL_BILLING_API_PASSWORD
// - header: RELAY_CREDENTIAL_BILLING_API_VALUE, sent in the header the envelope names
//
// No log line and no error message holds a secret's value.
import type { RelayEnvelope } from "@oxagen/mcp-studio";
import { CREDENTIAL_ENV_PREFIX } from "./config";

export type HeaderEntry = [name: string, value: string];

export type RelayCredential = NonNullable<RelayEnvelope["credential"]>;

export type CredentialPart = "TOKEN" | "USERNAME" | "PASSWORD" | "VALUE";

export type CredentialOutcome = { ok: true; headers: HeaderEntry[] } | { ok: false; message: string };

// CR and LF would end a header early, and NUL ends it in some servers.
const UNSAFE = /[\r\n\0]/;

/** The variable that holds one part of a credential. */
export function credentialEnvName(name: string, part: CredentialPart): string {
  return `${CREDENTIAL_ENV_PREFIX}${name.toUpperCase().replace(/-/g, "_")}_${part}`;
}

/**
 * The headers with the credential added. The credential replaces any header
 * of the same name. gRPC metadata names are lowercase.
 */
export function addCredential(
  headers: readonly HeaderEntry[],
  credential: RelayCredential | undefined,
  store: ReadonlyMap<string, string>,
  kind: "http" | "grpc",
): CredentialOutcome {
  if (credential === undefined) return { ok: true, headers: [...headers] };

  const problems: string[] = [];
  const read = (part: CredentialPart): string => {
    const envName = credentialEnvName(credential.name, part);
    const value = store.get(envName);
    if (value === undefined || value === "") {
      problems.push(`Set ${envName} in the relay's environment.`);
      return "";
    }
    if (UNSAFE.test(value)) {
      problems.push(`${envName} holds a line break or a NUL, so no request can carry it.`);
      return "";
    }
    return value;
  };

  let entry: HeaderEntry;
  switch (credential.scheme) {
    case "bearer":
      entry = ["authorization", `Bearer ${read("TOKEN")}`];
      break;
    case "basic": {
      const username = read("USERNAME");
      const password = read("PASSWORD");
      if (username.includes(":")) {
        problems.push(`${credentialEnvName(credential.name, "USERNAME")} holds a colon, which a basic user name cannot.`);
      }
      entry = ["authorization", `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`];
      break;
    }
    case "header":
      if (credential.header === undefined) {
        return { ok: false, message: `Credential ${credential.name} uses the header scheme but names no header.` };
      }
      entry = [credential.header, read("VALUE")];
      break;
    default: {
      const scheme = (credential as { scheme: string }).scheme;
      return {
        ok: false,
        message: `Credential ${credential.name} uses the ${scheme} scheme, which this relay version does not support. Update the relay.`,
      };
    }
  }
  if (problems.length > 0) {
    return { ok: false, message: `Credential ${credential.name} is not set up: ${problems.join(" ")}` };
  }

  const name = kind === "grpc" ? entry[0].toLowerCase() : entry[0];
  const lower = name.toLowerCase();
  const kept = headers.filter(([existing]) => existing.toLowerCase() !== lower);
  return { ok: true, headers: [...kept, [name, entry[1]]] };
}
