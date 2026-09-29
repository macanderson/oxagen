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
// - mutual_tls: RELAY_CREDENTIAL_BILLING_API_CERT and RELAY_CREDENTIAL_BILLING_API_KEY,
//   a PEM client certificate and its unencrypted PEM private key. The relay
//   adds no header. It presents the certificate in the TLS handshake with the
//   upstream, and the envelope schema allows it only on an https target.
//
// No log line and no error message holds a secret's value.
import { createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";
import type { RelayEnvelope } from "@oxagen/mcp-studio";
import { CREDENTIAL_ENV_PREFIX } from "./config";

export type HeaderEntry = [name: string, value: string];

export type RelayCredential = NonNullable<RelayEnvelope["credential"]>;

export type CredentialPart = "TOKEN" | "USERNAME" | "PASSWORD" | "VALUE" | "CERT" | "KEY";

/** A mutual_tls credential: the PEM certificate and key the relay presents to the upstream. */
export interface ClientCertificate {
  /** The credential's name. Senders key their TLS agents by it and name it in errors. */
  name: string;
  cert: string;
  key: string;
}

export type CredentialOutcome =
  | { ok: true; headers: HeaderEntry[]; clientCert?: ClientCertificate }
  | { ok: false; message: string };

// The characters each kind of request can carry in a value. An HTTP header
// takes what Node takes (its checkInvalidHeaderChar): tab, printable ASCII,
// and U+0080 to U+00FF. gRPC metadata takes printable ASCII only, as grpc-js
// does. The relay checks first, so the sender never refuses a secret in an
// error message that could quote it.
const UNSAFE: Record<"http" | "grpc", RegExp> = {
  http: /[^\t\x20-\x7e\x80-\xff]/,
  grpc: /[^\x20-\x7e]/,
};
const CARRIER: Record<"http" | "grpc", string> = { http: "an HTTP header", grpc: "gRPC metadata" };

/** The variable that holds one part of a credential. */
export function credentialEnvName(name: string, part: CredentialPart): string {
  return `${CREDENTIAL_ENV_PREFIX}${name.toUpperCase().replace(/-/g, "_")}_${part}`;
}

/**
 * Why a certificate and key cannot be presented, or undefined when they can.
 * Each message names the variable, never its value, and never passes on
 * OpenSSL's own text, which can quote the input.
 */
function certificateProblem(name: string, cert: string, key: string): string | undefined {
  const certVar = credentialEnvName(name, "CERT");
  const keyVar = credentialEnvName(name, "KEY");
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(cert);
  } catch {
    return `${certVar} does not hold a PEM certificate.`;
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(key);
  } catch {
    return `${keyVar} does not hold an unencrypted PEM private key.`;
  }
  let matches = false;
  try {
    matches = certificate.checkPrivateKey(privateKey);
  } catch {
    matches = false;
  }
  return matches ? undefined : `${keyVar} holds a key that does not match the certificate in ${certVar}.`;
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
  // A token or a header value goes out as written, so it must fit the
  // request. A basic user name and password go out as base64, which carries
  // any character.
  const read = (part: CredentialPart): string => {
    const envName = credentialEnvName(credential.name, part);
    const value = store.get(envName);
    if (value === undefined || value === "") {
      problems.push(`Set ${envName} in the relay's environment.`);
      return "";
    }
    if ((part === "TOKEN" || part === "VALUE") && UNSAFE[kind].test(value)) {
      problems.push(`${envName} holds a character ${CARRIER[kind]} cannot carry.`);
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
    case "mutual_tls": {
      // A PEM in one environment line often arrives with its line breaks
      // written as \n, as RELAY_TRUSTED_KEYS may.
      const cert = read("CERT").replace(/\\n/g, "\n");
      const key = read("KEY").replace(/\\n/g, "\n");
      const problem = problems.length > 0 ? problems.join(" ") : certificateProblem(credential.name, cert, key);
      if (problem !== undefined) {
        return { ok: false, message: `Credential ${credential.name} is not set up: ${problem}` };
      }
      return { ok: true, headers: [...headers], clientCert: { name: credential.name, cert, key } };
    }
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
