// apply-credential.ts: where an HTTP request carries the credential
// (mcp-studio-spec, Authentication).
//
// The MCP, HTTP, and GraphQL Senders record each request before they call
// this, so a recorded exchange never holds the secret. A bearer token or a
// basic pair goes in Authorization. An API key goes in the header, query
// parameter, or cookie that the server's scheme names. A relay credential
// travels beside the request, and the relay adds it itself.
//
// A secret leaves the vault only inside a ResolvedCredential, which lives for
// one call. Nothing here logs it, and no error message quotes it.
import type { ManifestAuth } from "../contract/manifest";
import type { RelayCredential } from "./credentials";
import type { SendCredential } from "./sender";
import type { HeaderEntry } from "./transport";
import { BuildError } from "./util";

/** What one request adds for the credential. */
export interface PlacedCredential {
  headers: HeaderEntry[];
  /** Query parameters, as [name, value] before percent-encoding. */
  query: Array<[name: string, value: string]>;
  /** Cookies, as [name, value], for the Cookie header. */
  cookies: Array<[name: string, value: string]>;
  relay_credential: RelayCredential | undefined;
}

// CR and LF would end a header early, and NUL ends it in some servers.
const UNSAFE = /[\r\n\0]/;

function checked(value: string, what: string): string {
  if (UNSAFE.test(value)) {
    throw new BuildError("Invalid credential", `The ${what} holds a line break or a NUL, so no request can carry it.`);
  }
  return value;
}

/** Place the credential by its type and the server's scheme. Throws BuildError when the two do not fit. */
export function placeCredential(
  auth: ManifestAuth | null,
  credential: SendCredential,
  network: string,
): PlacedCredential {
  switch (credential.type) {
    case "none":
      return { headers: [], query: [], cookies: [], relay_credential: undefined };
    case "relay":
      if (!network.startsWith("relay:")) {
        throw new BuildError(
          "Invalid credential",
          `A relay credential needs a relay network, but this environment's network is ${network}.`,
        );
      }
      return { headers: [], query: [], cookies: [], relay_credential: credential.credential };
    case "bearer":
      return {
        headers: [["Authorization", `Bearer ${checked(credential.token, "access token")}`]],
        query: [],
        cookies: [],
        relay_credential: undefined,
      };
    case "basic": {
      const username = checked(credential.username, "user name");
      if (username.includes(":")) {
        throw new BuildError("Invalid credential", "A basic credential's user name cannot hold a colon (RFC 7617).");
      }
      const pair = Buffer.from(`${username}:${checked(credential.password, "password")}`, "utf8").toString("base64");
      return { headers: [["Authorization", `Basic ${pair}`]], query: [], cookies: [], relay_credential: undefined };
    }
    case "api_key": {
      const apply = auth?.apply;
      if (apply?.type !== "api_key" || apply.name === undefined || apply.in === undefined) {
        throw new BuildError("Invalid credential", "An API key needs an api_key auth scheme that names where it goes.");
      }
      const value = checked(credential.value, "API key");
      switch (apply.in) {
        case "header":
          return { headers: [[apply.name, value]], query: [], cookies: [], relay_credential: undefined };
        case "query":
          return { headers: [], query: [[apply.name, value]], cookies: [], relay_credential: undefined };
        case "cookie":
          if (/[;,\s"\\]/.test(value)) {
            throw new BuildError(
              "Invalid credential",
              "The API key holds a character a cookie cannot carry: a space, a quote, a comma, a semicolon, or a backslash.",
            );
          }
          return { headers: [], query: [], cookies: [[apply.name, value]], relay_credential: undefined };
      }
    }
  }
}
