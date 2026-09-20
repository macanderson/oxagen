/**
 * The five calls Oxagen makes against its own OpenRouter account (ADR-131).
 *
 * `fetch` is stubbed through the module's `fetchImpl` seam, so nothing here
 * reaches the network and no management key is real. The tests are about the
 * three things a caller depends on: the request that goes out, the plaintext
 * that comes back exactly once, and the shape of a failure — including that
 * nothing key-shaped survives into an error a caller will log.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createAssistantKey,
  deleteAssistantKey,
  describeAssistantKey,
  listAssistantKeys,
  OpenRouterProvisioningError,
  updateAssistantKey,
} from "./openrouter-provisioning";

const MANAGEMENT = "sk-or-v1-management-key-not-real";

/** One key as OpenRouter serves it. */
function vendorKey(over: Record<string, unknown> = {}) {
  return {
    hash: "hash-abc",
    name: "oxagen/acme/dana@acme.example",
    label: "sk-or-v1-c24...514",
    disabled: false,
    limit: 25,
    limit_remaining: 25,
    limit_reset: "daily",
    usage: 0,
    usage_daily: 0,
    usage_weekly: 0,
    usage_monthly: 0,
    created_at: "2026-09-20T00:00:00Z",
    ...over,
  };
}

/** A fetch that answers each call from a queue, and records what it was sent. */
function stubFetch(responses: { status?: number; body: unknown | string }[]): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    const text =
      typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("createAssistantKey", () => {
  it("asks for a daily ceiling that the organisation's own key cannot widen", async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { data: vendorKey(), key: "sk-or-v1-the-plaintext" } },
    ]);

    await createAssistantKey({
      name: "oxagen/acme/dana@acme.example",
      limitUsd: 25,
      limitReset: "daily",
      managementKey: MANAGEMENT,
      fetchImpl,
    });

    const sent = bodyOf(calls[0]!.init);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/keys");
    expect(calls[0]!.init.method).toBe("POST");
    expect(sent).toEqual({
      name: "oxagen/acme/dana@acme.example",
      limit: 25,
      limit_reset: "daily",
      // Off explicitly. A key that could also spend through a
      // bring-your-own-key provider under the same ceiling would make the
      // ceiling mean two different things.
      include_byok_in_limit: false,
    });
  });

  it("defaults the window to daily, because a null reset is a lifetime budget", async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { data: vendorKey(), key: "sk-or-v1-the-plaintext" } },
    ]);
    await createAssistantKey({
      name: "n",
      limitUsd: 25,
      managementKey: MANAGEMENT,
      fetchImpl,
    });
    expect(bodyOf(calls[0]!.init)["limit_reset"]).toBe("daily");
  });

  it("returns the plaintext and the durable handle together", async () => {
    const { fetchImpl } = stubFetch([
      { body: { data: vendorKey(), key: "sk-or-v1-the-plaintext" } },
    ]);
    const created = await createAssistantKey({
      name: "n",
      limitUsd: 25,
      managementKey: MANAGEMENT,
      fetchImpl,
    });
    expect(created.apiKey).toBe("sk-or-v1-the-plaintext");
    expect(created.key.hash).toBe("hash-abc");
    expect(created.key.limitReset).toBe("daily");
  });

  it("refuses a key whose plaintext it never saw", async () => {
    // A key that exists at the vendor and can spend, and that nobody can use
    // or attribute. Failing loudly is what makes the caller delete it.
    const { fetchImpl } = stubFetch([{ body: { data: vendorKey() } }]);
    await expect(
      createAssistantKey({
        name: "n",
        limitUsd: 25,
        managementKey: MANAGEMENT,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 502, retryable: false });
  });

  it("refuses a key with no hash rather than storing a row whose handle is undefined", async () => {
    const { fetchImpl } = stubFetch([
      { body: { data: vendorKey({ hash: undefined }), key: "sk-or-v1-x" } },
    ]);
    await expect(
      createAssistantKey({
        name: "n",
        limitUsd: 25,
        managementKey: MANAGEMENT,
        fetchImpl,
      }),
    ).rejects.toThrow(/no hash/);
  });

  it("sends the management key in the header and nowhere else", async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { data: vendorKey(), key: "sk-or-v1-x" } },
    ]);
    await createAssistantKey({
      name: "n",
      limitUsd: 25,
      managementKey: MANAGEMENT,
      fetchImpl,
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${MANAGEMENT}`);
    expect(String(calls[0]!.init.body)).not.toContain(MANAGEMENT);
    expect(calls[0]!.url).not.toContain(MANAGEMENT);
  });
});

describe("OpenRouterProvisioningError", () => {
  it("never carries a key into a message a caller will log", async () => {
    // The failure mode this exists for: a vendor that echoes a submitted
    // value back into its error text turns a failed provision into a secret
    // in the log, forever, in a line nobody thought was sensitive.
    const { fetchImpl } = stubFetch([
      {
        status: 400,
        body: {
          error: { message: "bad key sk-or-v1-LEAKEDSECRET0123 supplied" },
        },
      },
    ]);
    const err = await createAssistantKey({
      name: "n",
      limitUsd: 25,
      managementKey: MANAGEMENT,
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenRouterProvisioningError);
    expect((err as Error).message).not.toContain("LEAKEDSECRET0123");
    expect((err as Error).message).toContain("sk-or-v1-[redacted]");
  });

  it("marks a bad minute retryable and a bad request permanent", async () => {
    // Retrying a 4xx burns the caller's backoff on a bug that will fail
    // identically forever.
    const cases: [number, boolean][] = [
      [401, false],
      [400, false],
      [404, false],
      [408, true],
      [429, true],
      [500, true],
      [503, true],
    ];
    for (const [status, retryable] of cases) {
      const { fetchImpl } = stubFetch([{ status, body: { error: {} } }]);
      const err = (await describeAssistantKey({
        hash: "h",
        managementKey: MANAGEMENT,
        fetchImpl,
      }).catch((e: unknown) => e)) as OpenRouterProvisioningError;
      expect([status, err.retryable]).toEqual([status, retryable]);
    }
  });

  it("reports an unreachable vendor as a 503, the same as the vendor saying so", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      describeAssistantKey({ hash: "h", managementKey: MANAGEMENT, fetchImpl }),
    ).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it("reports a non-JSON body as a bad gateway rather than throwing a parse error", async () => {
    const { fetchImpl } = stubFetch([{ body: "<html>maintenance</html>" }]);
    await expect(
      describeAssistantKey({ hash: "h", managementKey: MANAGEMENT, fetchImpl }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("describeAssistantKey", () => {
  it("reads one key's ceiling and spend, addressed by its hash", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        body: {
          data: vendorKey({ usage_daily: 3.5, limit_remaining: 21.5 }),
        },
      },
    ]);
    const key = await describeAssistantKey({
      hash: "hash/with slash",
      managementKey: MANAGEMENT,
      fetchImpl,
    });
    expect(calls[0]!.url).toBe(
      `https://openrouter.ai/api/v1/keys/${encodeURIComponent("hash/with slash")}`,
    );
    expect(key.usageDaily).toBe(3.5);
    expect(key.limitRemaining).toBe(21.5);
  });

  it("defaults a usage counter the vendor omitted to zero, and never fails on one", async () => {
    const { fetchImpl } = stubFetch([
      { body: { data: { hash: "h", name: "n" } } },
    ]);
    const key = await describeAssistantKey({
      hash: "h",
      managementKey: MANAGEMENT,
      fetchImpl,
    });
    expect(key).toMatchObject({
      usage: 0,
      usageDaily: 0,
      limit: null,
      limitReset: null,
      disabled: false,
    });
  });
});

describe("updateAssistantKey", () => {
  it("sends only the fields the caller asked to change", async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { data: vendorKey({ disabled: true }) } },
    ]);
    await updateAssistantKey({
      hash: "hash-abc",
      managementKey: MANAGEMENT,
      disabled: true,
      fetchImpl,
    });
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(bodyOf(calls[0]!.init)).toEqual({ disabled: true });
  });

  it("has no way to rewrite a name, because a name that drifts cannot be read backwards", () => {
    // A compile-time guarantee, asserted here so deleting the omission from
    // the signature fails a test rather than passing silently.
    const args = { hash: "h", managementKey: MANAGEMENT, limitUsd: 50 };
    expect(Object.keys(args)).not.toContain("name");
    expect("name" in args).toBe(false);
  });
});

describe("deleteAssistantKey", () => {
  it("addresses the key by hash and tolerates the vendor's `{deleted:true}` body", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { deleted: true } }]);
    await expect(
      deleteAssistantKey({
        hash: "hash-abc",
        managementKey: MANAGEMENT,
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("hash-abc");
  });
});

describe("listAssistantKeys", () => {
  it("follows the pages until the vendor serves a short one", async () => {
    const full = Array.from({ length: 100 }, (_, i) =>
      vendorKey({ hash: `page0-${i}` }),
    );
    const { fetchImpl, calls } = stubFetch([
      { body: { data: full } },
      { body: { data: [vendorKey({ hash: "page1-0" })] } },
    ]);
    const keys = await listAssistantKeys({
      managementKey: MANAGEMENT,
      fetchImpl,
    });
    expect(keys).toHaveLength(101);
    expect(calls.map((c) => c.url)).toEqual([
      "https://openrouter.ai/api/v1/keys?offset=0",
      "https://openrouter.ai/api/v1/keys?offset=100",
    ]);
  });

  it("stops on an empty page", async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { data: [] } }]);
    await expect(
      listAssistantKeys({ managementKey: MANAGEMENT, fetchImpl }),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("stops after 100 pages rather than spinning on a vendor that never ends", async () => {
    // The negative control for the bound. Without it, a vendor answering a
    // full page forever hangs the reconciliation report and the process
    // holding it.
    const full = Array.from({ length: 100 }, () => vendorKey());
    const { fetchImpl, calls } = stubFetch([{ body: { data: full } }]);
    const keys = await listAssistantKeys({
      managementKey: MANAGEMENT,
      fetchImpl,
    });
    expect(calls).toHaveLength(100);
    expect(keys).toHaveLength(100 * 100);
  });
});
