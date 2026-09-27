// request.ts: the target and the call metadata of one gRPC call.
//
// The target is a relay envelope's grpc target, so the relay broker (M12)
// signs exactly what the direct carrier would dial. The credential travels as
// call metadata (mcp-studio-spec, Server file: "gRPC sends it as call
// metadata").
import { relayGrpcTargetSchema } from "../../contract/relay-envelope";
import type { ManifestAuth } from "../../contract/manifest";
import type { GrpcRequest } from "../../model/upstream-tool";
import type { RelayCredential } from "../credentials";
import type { SendCredential } from "../sender";
import type { GrpcTarget, HeaderEntry } from "../transport";

/** Why a call could not be built. Nothing was sent. */
export class RequestError extends Error {
  readonly title: string;

  constructor(title: string, message: string) {
    super(message);
    this.name = "RequestError";
    this.title = title;
  }
}

/** Build the target from the environment's url and the template's method. */
export function buildTarget(url: string | undefined, method: GrpcRequest["method"]): GrpcTarget {
  if (url === undefined) {
    throw new RequestError("Invalid environment", "The environment has no url, so the call has no host.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RequestError("Invalid environment", `The environment url ${url} does not parse.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RequestError(
      "Invalid environment",
      `A gRPC environment url is https or http, not ${parsed.protocol.slice(0, -1)}.`,
    );
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || parsed.username !== "" || parsed.password !== "") {
    throw new RequestError(
      "Invalid environment",
      `A gRPC environment url is a scheme, a host, and a port, with no path, query, or user: ${url}.`,
    );
  }
  const slash = method.lastIndexOf("/");
  // URL drops the scheme's default port, which is how the envelope writes it.
  const target = relayGrpcTargetSchema.safeParse({
    kind: "grpc",
    scheme: parsed.protocol === "https:" ? "https" : "http",
    host: parsed.hostname.toLowerCase(),
    port: parsed.port === "" ? undefined : Number(parsed.port),
    service: method.slice(0, slash),
    method: method.slice(slash + 1),
  });
  if (!target.success) {
    const issue = target.error.issues[0];
    const detail = issue === undefined ? target.error.message : `${issue.path.join(".")}: ${issue.message}`;
    throw new RequestError("Invalid environment", `The call target is not valid (${detail}).`);
  }
  return target.data;
}

/** The metadata to send and the credential a relay adds itself. */
export interface CallCredentials {
  metadata: HeaderEntry[];
  relay_credential: RelayCredential | undefined;
}

// gRPC metadata names are lowercase ASCII letters, digits, and _ . -. A name
// that ends in -bin carries bytes, and grpc- names belong to the protocol.
const METADATA_NAME = /^[0-9a-z_.-]+$/;
const METADATA_VALUE = /^[\x20-\x7e]*$/;

function metadataEntry(name: string, value: string): HeaderEntry {
  const lower = name.toLowerCase();
  if (!METADATA_NAME.test(lower) || lower.endsWith("-bin") || lower.startsWith("grpc-")) {
    throw new RequestError(
      "Invalid credential",
      `${name} cannot carry a credential in gRPC metadata. Name a header of lowercase letters, digits, and _ . - in the auth scheme.`,
    );
  }
  if (!METADATA_VALUE.test(value)) {
    throw new RequestError(
      "Invalid credential",
      `The credential for ${lower} has characters gRPC metadata cannot carry. Store it as printable ASCII.`,
    );
  }
  return [lower, value];
}

/** Turn the credential into call metadata, or into the relay's own credential on a relay network. */
export function buildCredentials(
  auth: ManifestAuth | null,
  credential: SendCredential,
  network: string,
): CallCredentials {
  switch (credential.type) {
    case "none":
      return { metadata: [], relay_credential: undefined };
    case "relay":
      if (!network.startsWith("relay:")) {
        throw new RequestError(
          "Invalid credential",
          `A relay credential needs a relay network, but this environment's network is ${network}.`,
        );
      }
      return { metadata: [], relay_credential: credential.credential };
    case "bearer":
      return { metadata: [metadataEntry("authorization", `Bearer ${credential.token}`)], relay_credential: undefined };
    case "basic": {
      const pair = Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64");
      return { metadata: [metadataEntry("authorization", `Basic ${pair}`)], relay_credential: undefined };
    }
    case "api_key": {
      const apply = auth?.apply;
      if (apply?.type !== "api_key" || apply.name === undefined) {
        throw new RequestError("Invalid credential", "An API key needs an api_key auth scheme with a header name.");
      }
      if (apply.in !== "header") {
        throw new RequestError(
          "Invalid credential",
          `A gRPC call has no ${apply.in ?? "query"} to carry an API key. Set the scheme's key in a header.`,
        );
      }
      return { metadata: [metadataEntry(apply.name, credential.value)], relay_credential: undefined };
    }
  }
}
