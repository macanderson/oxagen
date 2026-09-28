// auth.test.ts: the environments import suggests, held to the executor's base-url rule.
import { describe, expect, it } from "vitest";
import { parseEndpoint } from "../execute/endpoint";
import type { ImportNote } from "../model/import-result";
import { readAuth, readEnvironments } from "./auth";
import { Resolver } from "./resolve";

/** The environments and notes for a document whose servers are `servers`. */
function read(servers: unknown[]): { urls: string[]; notes: string[] } {
  const notes: ImportNote[] = [];
  const environments = readEnvironments({ openapi: "3.1.0", servers }, notes);
  return {
    urls: environments.map((environment) => environment.url),
    notes: notes.map((note) => note.message),
  };
}

describe("readEnvironments", () => {
  it("keeps a plain https server", () => {
    expect(read([{ url: "https://api.example.com/v2" }])).toEqual({
      urls: ["https://api.example.com/v2"],
      notes: [],
    });
  });

  it.each([
    [
      "a query",
      "https://api.example.com/v2?version=2",
      "An API's base url has no query: https://api.example.com/v2?version=2.",
    ],
    [
      "a fragment",
      "https://api.example.com/v2#top",
      "An environment url has no fragment: https://api.example.com/v2#top.",
    ],
    [
      "an IPv6 host",
      "https://[2001:db8::1]/v2",
      "An IPv6 host is not supported. Name the host, or use an IPv4 address.",
    ],
  ])("skips a server with %s, with a note naming it", (_, url, reason) => {
    // The executor refuses this url, so a tool call through it would fail.
    expect(() => parseEndpoint(url, "base")).toThrow(reason);
    expect(read([{ url }, { url: "https://api.example.com/v2" }])).toEqual({
      urls: ["https://api.example.com/v2"],
      notes: [
        `Import skipped the server "${url}", because a tool call cannot use it as a base url. ${reason} ` +
          "Set the environment's url in server.toml.",
      ],
    });
  });

  it("checks a templated server after its variables take their defaults", () => {
    const kept = read([
      {
        url: "https://{region}.example.com/v2",
        variables: { region: { default: "eu" } },
      },
    ]);
    expect(kept).toEqual({ urls: ["https://eu.example.com/v2"], notes: [] });

    const refused = read([
      {
        url: "https://api.example.com/{version}",
        variables: { version: { default: "v2?beta=1" } },
      },
    ]);
    expect(refused.urls).toEqual([]);
    expect(refused.notes).toEqual([
      'Import skipped the server "https://api.example.com/{version}", because a tool call cannot use it as a base url. ' +
        "An API's base url has no query: https://api.example.com/v2?beta=1. Set the environment's url in server.toml.",
    ]);
  });
});

describe("readAuth scopes", () => {
  /** The scopes and notes import reads from one oauth2 scheme whose flows offer `flows`. */
  function scopes(flows: Record<string, unknown>): {
    scopes: string[] | undefined;
    notes: string[];
  } {
    const notes: ImportNote[] = [];
    const document = {
      openapi: "3.1.0",
      components: { securitySchemes: { oauth: { type: "oauth2", flows } } },
    };
    const [auth] = readAuth(document, new Resolver(document, notes), notes);
    const offered = auth?.type === "oauth2" ? auth.scopes : undefined;
    return { scopes: offered, notes: notes.map((entry) => entry.message) };
  }
  const tokenUrl = "https://auth.example.com/token";

  it("keeps each scope once, in the order the flows offer them", () => {
    const read = scopes({
      clientCredentials: { tokenUrl, scopes: { read: "", write: "" } },
      password: { tokenUrl, scopes: { write: "", admin: "" } },
    });
    expect(read).toEqual({ scopes: ["read", "write", "admin"], notes: [] });
  });

  it("keeps the first 256 unique scopes and counts every unique scope in the note", () => {
    const many = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, i) => [`scope_${i}`, ""]),
    );
    // The second flow repeats every scope, which must not raise the count.
    const read = scopes({
      clientCredentials: { tokenUrl, scopes: many },
      password: { tokenUrl, scopes: many },
    });
    expect(read.scopes).toHaveLength(256);
    expect(read.scopes?.[0]).toBe("scope_0");
    expect(read.scopes?.[255]).toBe("scope_255");
    expect(read.notes).toEqual([
      "The security scheme oauth offers 20000 scopes. Import kept the first 256.",
    ]);
  });
});
