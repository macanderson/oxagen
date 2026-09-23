import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __tokenCache,
  createAppInstallationToken,
  getInstallationToken,
} from "./app-auth";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const base = {
  appId: "12345",
  privateKey: pem,
  installationId: 987,
  baseUrl: "https://ghe.example",
  now: () => 1_700_000_000_000,
};

function minted(token: string): Response {
  return new Response(
    JSON.stringify({ token, expires_at: "2100-01-01T00:00:00Z" }),
    { status: 201 },
  );
}

// Typed parameters, so `mock.calls[n]` is `[input, init]` and not an empty tuple.
function fetchReturning(respond: () => Response) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    respond(),
  );
}

function sentBody(
  fetchMock: ReturnType<typeof fetchReturning>,
  call = 0,
): unknown {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return init?.body === undefined ? undefined : JSON.parse(init.body as string);
}

beforeEach(() => {
  __tokenCache.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAppInstallationToken", () => {
  it("posts no body when nothing narrows the token", async () => {
    const fetchMock = fetchReturning(() => minted("ghs_full"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await createAppInstallationToken(base);
    expect(result.token).toBe("ghs_full");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://ghe.example/app/installations/987/access_tokens",
    );
    expect(sentBody(fetchMock)).toBeUndefined();
  });

  it("posts the repositories and permissions that narrow the token", async () => {
    const fetchMock = fetchReturning(() => minted("ghs_narrow"));
    vi.stubGlobal("fetch", fetchMock);
    await createAppInstallationToken({
      ...base,
      repositories: ["oxagen"],
      permissions: { contents: "read", pull_requests: "write" },
    });
    expect(sentBody(fetchMock)).toEqual({
      repositories: ["oxagen"],
      permissions: { contents: "read", pull_requests: "write" },
    });
  });

  it("treats an empty narrowing as no narrowing", async () => {
    const fetchMock = fetchReturning(() => minted("ghs_full"));
    vi.stubGlobal("fetch", fetchMock);
    await createAppInstallationToken({
      ...base,
      repositories: [],
      permissions: {},
    });
    expect(sentBody(fetchMock)).toBeUndefined();
  });

  it("surfaces GitHub's message when the mint is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Resource not accessible" }), {
            status: 422,
          }),
      ),
    );
    await expect(
      createAppInstallationToken({ ...base, repositories: ["other"] }),
    ).rejects.toThrow(
      "GitHub App token mint failed (422): Resource not accessible",
    );
  });
});

describe("getInstallationToken", () => {
  it("never serves a full-grant token to a narrowed request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(minted("ghs_full"))
      .mockResolvedValueOnce(minted("ghs_narrow"));
    vi.stubGlobal("fetch", fetchMock);
    const full = await getInstallationToken(base);
    const narrow = await getInstallationToken({
      ...base,
      repositories: ["oxagen"],
      permissions: { contents: "read" },
    });
    expect(full.token).toBe("ghs_full");
    expect(narrow.token).toBe("ghs_narrow");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a narrowed token for the same narrowing in any order", async () => {
    const fetchMock = fetchReturning(() => minted("ghs_narrow"));
    vi.stubGlobal("fetch", fetchMock);
    await getInstallationToken({
      ...base,
      repositories: ["b", "a"],
      permissions: { pull_requests: "write", contents: "read" },
    });
    const again = await getInstallationToken({
      ...base,
      repositories: ["a", "b"],
      permissions: { contents: "read", pull_requests: "write" },
    });
    expect(again.token).toBe("ghs_narrow");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a full-grant token until sixty seconds before expiry", async () => {
    let clock = 1_700_000_000_000;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            token: `ghs_${clock}`,
            expires_at: new Date(clock + 3_600_000).toISOString(),
          }),
          { status: 201 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const args = { ...base, now: () => clock };
    const first = await getInstallationToken(args);
    clock += 3_600_000 - 61_000;
    expect((await getInstallationToken(args)).token).toBe(first.token);
    clock += 2_000;
    expect((await getInstallationToken(args)).token).not.toBe(first.token);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
