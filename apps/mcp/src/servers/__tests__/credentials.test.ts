// credentials.test.ts: the served source builds the vault's source on its
// first resolve, reuses it, and builds again after a failed build (lane M15).
import type { CredentialRequest, CredentialSource, ResolvedCredential } from "@oxagen/mcp-studio";
import { describe, expect, it } from "vitest";
import { lazyCredentialSource } from "../credentials";
import { OPERATOR } from "./fixtures";

const REQUEST: CredentialRequest = {
  server: "billing",
  environment: "sandbox",
  reference: undefined,
  auth: {
    mode: "operator-oauth",
    scheme: "oauth",
    apply: { type: "oauth2", token_url: "https://auth.billing.example/token", scopes: ["read"] },
  },
  operator: OPERATOR,
};

const TOKEN: ResolvedCredential = { type: "bearer", token: "tok_never_logged" };

function vault(answer: ResolvedCredential = TOKEN) {
  const asked: Array<{ request: CredentialRequest; signal: AbortSignal }> = [];
  const source: CredentialSource = {
    resolve: (request, signal) => {
      asked.push({ request, signal });
      return Promise.resolve(answer);
    },
  };
  return { source, asked };
}

describe("lazyCredentialSource", () => {
  it("builds nothing until a call asks for a credential", () => {
    let builds = 0;
    lazyCredentialSource(() => {
      builds += 1;
      return Promise.resolve(vault().source);
    });
    expect(builds).toBe(0);
  });

  it("hands the request and the signal to the vault's source and returns its answer", async () => {
    const { source, asked } = vault();
    const lazy = lazyCredentialSource(() => Promise.resolve(source));
    const signal = new AbortController().signal;
    expect(await lazy.resolve(REQUEST, signal)).toEqual(TOKEN);
    expect(asked).toEqual([{ request: REQUEST, signal }]);
  });

  it("builds once for every call in the request", async () => {
    let builds = 0;
    const { source, asked } = vault();
    const lazy = lazyCredentialSource(() => {
      builds += 1;
      return Promise.resolve(source);
    });
    const signal = new AbortController().signal;
    await Promise.all([lazy.resolve(REQUEST, signal), lazy.resolve(REQUEST, signal)]);
    await lazy.resolve(REQUEST, signal);
    expect(builds).toBe(1);
    expect(asked).toHaveLength(3);
  });

  it("rejects when the build fails and builds again on the next call", async () => {
    let builds = 0;
    const { source } = vault();
    const lazy = lazyCredentialSource(() => {
      builds += 1;
      return builds === 1 ? Promise.reject(new Error("The run's workspace does not exist.")) : Promise.resolve(source);
    });
    const signal = new AbortController().signal;
    await expect(lazy.resolve(REQUEST, signal)).rejects.toThrow("The run's workspace does not exist.");
    expect(await lazy.resolve(REQUEST, signal)).toEqual(TOKEN);
    expect(builds).toBe(2);
  });
});
