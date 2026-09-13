/**
 * github.test.ts — fetchGithubStatus surfaces the server's error message.
 *
 * Witness for the "[object Object]" dialog: the API's error middleware answers
 * a thrown error with `{ error: { code, message }, requestId }`, and the old
 * client passed that object straight to `new Error(...)`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGithubStatus } from "./github";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGithubStatus", () => {
  it("shows the middleware envelope's message and request id on a 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(500, {
          error: { code: "internal_error", message: "Unexpected server error" },
          requestId: "ce939a94-cb56-4b75-974a-c707fb11b4d6",
        }),
      ),
    );

    await expect(fetchGithubStatus("oxagen", "default")).rejects.toThrow(
      "Unexpected server error (request ce939a94-cb56-4b75-974a-c707fb11b4d6)",
    );
  });

  it("shows a route-level string error unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(503, { error: "GitHub App is not configured" }),
      ),
    );

    await expect(fetchGithubStatus("oxagen", "default")).rejects.toThrow(
      "GitHub App is not configured",
    );
  });

  it("falls back to the status code when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<html>bad gateway</html>", { status: 502 }),
      ),
    );

    await expect(fetchGithubStatus("oxagen", "default")).rejects.toThrow(
      "Failed to load GitHub status (502)",
    );
  });

  it("returns the parsed status on a 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          connected: false,
          installations: [],
          manageUrl: "https://github.com/apps/oxagen/installations",
          installUrl: "https://github.com/apps/oxagen/installations/new",
          identityUrl: "https://github.com/login/oauth/authorize",
        }),
      ),
    );

    await expect(fetchGithubStatus("oxagen", "default")).resolves.toMatchObject(
      { connected: false },
    );
  });
});
