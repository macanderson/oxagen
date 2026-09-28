// auth.test.ts: the environments import suggests, held to the executor's base-url rule.
import { describe, expect, it } from "vitest";
import { parseEndpoint } from "../execute/endpoint";
import type { ImportNote } from "../model/import-result";
import { readEnvironments } from "./auth";

/** The environments and notes for a document whose servers are `servers`. */
function read(servers: unknown[]): { urls: string[]; notes: string[] } {
  const notes: ImportNote[] = [];
  const environments = readEnvironments({ openapi: "3.1.0", servers }, notes);
  return { urls: environments.map((environment) => environment.url), notes: notes.map((note) => note.message) };
}

describe("readEnvironments", () => {
  it("keeps a plain https server", () => {
    expect(read([{ url: "https://api.example.com/v2" }])).toEqual({ urls: ["https://api.example.com/v2"], notes: [] });
  });

  it.each([
    ["a query", "https://api.example.com/v2?version=2", "An API's base url has no query: https://api.example.com/v2?version=2."],
    ["a fragment", "https://api.example.com/v2#top", "An environment url has no fragment: https://api.example.com/v2#top."],
    ["an IPv6 host", "https://[2001:db8::1]/v2", "An IPv6 host is not supported. Name the host, or use an IPv4 address."],
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
    const kept = read([{ url: "https://{region}.example.com/v2", variables: { region: { default: "eu" } } }]);
    expect(kept).toEqual({ urls: ["https://eu.example.com/v2"], notes: [] });

    const refused = read([{ url: "https://api.example.com/{version}", variables: { version: { default: "v2?beta=1" } } }]);
    expect(refused.urls).toEqual([]);
    expect(refused.notes).toEqual([
      'Import skipped the server "https://api.example.com/{version}", because a tool call cannot use it as a base url. ' +
        "An API's base url has no query: https://api.example.com/v2?beta=1. Set the environment's url in server.toml.",
    ]);
  });
});
