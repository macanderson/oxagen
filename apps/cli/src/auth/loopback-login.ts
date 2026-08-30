/**
 * Browser-based loopback OAuth + PKCE login flow.
 *
 * 1. Generates a PKCE code_verifier + S256 challenge and a random state nonce.
 * 2. Binds a one-shot HTTP server to 127.0.0.1 on an ephemeral port.
 * 3. Opens the Oxagen app's /cli/authorize page in the default browser.
 * 4. Waits for the callback GET /callback?code=…&state=…, validates state,
 *    sends a friendly "you can close this tab" HTML page, then exchanges the
 *    authorization code for a token via POST /v1/auth/cli/token.
 * 5. Returns { token, orgSlug, workspaceSlug } for the caller to persist.
 *
 * Security notes:
 * - The code_verifier is NEVER logged.
 * - The returned token is NEVER logged.
 * - The state nonce must match exactly before the code is exchanged (CSRF guard).
 * - The token-exchange response is shape-checked before it is returned, so a
 *   malformed 200 can never be persisted as a broken credential.
 * - The server only binds to 127.0.0.1 (loopback) — never 0.0.0.0.
 * - A 5-minute timeout closes the server and rejects the promise if the user
 *   doesn't complete the flow.
 *
 * UI-agnostic by design: status lines go through the optional `onStatus`
 * callback instead of a hardcoded `process.stdout.write` (default preserves
 * the original one-shot CLI behavior exactly), and the wait can be cancelled
 * early via an optional `signal` — both are what let the REPL's Ink-native
 * `/login` panel (see repl/login-panel.tsx) drive this exact flow without
 * ever touching the real terminal or readline while Ink owns raw mode.
 */
import * as http from "node:http";
import * as os from "node:os";
import {
  generateCodeVerifier,
  codeChallengeS256,
  generateState,
} from "./pkce.js";
import { openBrowser } from "./open-browser.js";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** The credential triple the token-exchange endpoint returns on success. */
interface TokenExchangeResponse {
  token: string;
  orgSlug: string;
  workspaceSlug: string;
}

/**
 * Narrow an already-parsed token-exchange body to {@link TokenExchangeResponse}.
 * A 200 whose body is missing any of the three strings would otherwise be cast
 * straight through and persisted as `undefined` credentials — a session that
 * looks logged in and 401s on every call. Fail loudly at the exchange instead.
 */
function asTokenExchangeResponse(body: unknown): TokenExchangeResponse {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const nonEmpty = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const token = nonEmpty(record["token"]);
  const orgSlug = nonEmpty(record["orgSlug"]);
  const workspaceSlug = nonEmpty(record["workspaceSlug"]);
  if (!token || !orgSlug || !workspaceSlug) {
    throw new Error(
      "Token exchange returned an unexpected response (expected token, orgSlug, workspaceSlug).",
    );
  }
  return { token, orgSlug, workspaceSlug };
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Oxagen — Login complete</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center;
           align-items: center; min-height: 100vh; margin: 0; background: #f4f4f5; }
    .card { background: #fff; border-radius: 10px; padding: 2.5rem 3rem;
            text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,.10); max-width: 380px; }
    h1 { color: #16a34a; margin: 0 0 .6rem; font-size: 1.5rem; }
    p  { color: #555; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Login complete</h1>
    <p>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`;

function makeErrorHtml(message: string): string {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Oxagen — Login failed</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center;
           align-items: center; min-height: 100vh; margin: 0; background: #f4f4f5; }
    .card { background: #fff; border-radius: 10px; padding: 2.5rem 3rem;
            text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,.10); max-width: 380px; }
    h1 { color: #dc2626; margin: 0 0 .6rem; font-size: 1.5rem; }
    p  { color: #555; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Login failed</h1>
    <p>${escaped}</p>
  </div>
</body>
</html>`;
}

/**
 * Run the interactive browser-based PKCE login flow and return the credential
 * triple { token, orgSlug, workspaceSlug } on success.
 *
 * Rejects with a descriptive Error on:
 *   - state mismatch (CSRF guard)
 *   - authorization error from the provider
 *   - non-200 from the token-exchange endpoint
 *   - 5-minute idle timeout
 *   - `signal` aborted (caller cancelled — e.g. the user pressed Esc in the
 *     REPL's `/login` panel)
 */
export async function browserLogin({
  apiUrl,
  appUrl,
  onStatus,
  signal,
}: {
  apiUrl: string;
  appUrl: string;
  /** Status-line sink. Defaults to the real stdout (one-shot CLI behavior). */
  onStatus?: (line: string) => void;
  /** Abort the in-flight wait early (closes the loopback server, rejects). */
  signal?: AbortSignal;
}): Promise<{ token: string; orgSlug: string; workspaceSlug: string }> {
  const emit =
    onStatus ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = codeChallengeS256(codeVerifier);
  const state = generateState();

  // Bind a loopback server to an OS-assigned ephemeral port.
  const server = http.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(
          new Error("Failed to bind loopback server: address unavailable"),
        );
        return;
      }
      resolve(addr.port);
    });
  });

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    label: os.hostname(),
  });
  const authorizeUrl = `${appUrl}/cli/authorize?${params.toString()}`;

  // Always surface the URL so the user can paste it if the browser fails to open.
  emit("Opening browser for authentication...");
  emit(`If your browser didn't open, paste this URL:\n  ${authorizeUrl}`);
  openBrowser(authorizeUrl);

  return new Promise<{ token: string; orgSlug: string; workspaceSlug: string }>(
    (resolve, reject) => {
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          server.close();
          reject(
            new Error(
              "Login timed out after 5 minutes. Run `oxagen login` to try again.",
            ),
          );
        }
      }, LOGIN_TIMEOUT_MS);

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        server.close();
        reject(new Error("Login cancelled."));
      };
      signal?.addEventListener("abort", onAbort);

      /** Mark the flow complete, stop the server, and call `action`. */
      const closeAndSettle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        server.close();
        action();
      };

      server.on("request", (req, res) => {
        // Guard against duplicate requests after we've already settled.
        if (settled) {
          res.writeHead(503).end();
          return;
        }

        const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404).end("Not found");
          return;
        }

        const returnedState = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");
        const code = reqUrl.searchParams.get("code");

        /** Write an HTML response and wait for it to flush. */
        const sendHtml = (html: string): Promise<void> =>
          new Promise<void>((r) => {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(html, r);
          });

        void (async () => {
          try {
            // ── CSRF guard ────────────────────────────────────────────────────
            if (returnedState !== state) {
              await sendHtml(
                makeErrorHtml("State mismatch. This may be a CSRF attempt."),
              );
              closeAndSettle(() =>
                reject(new Error("state mismatch (possible CSRF)")),
              );
              return;
            }

            // ── Provider error ────────────────────────────────────────────────
            if (error) {
              await sendHtml(makeErrorHtml(`Authorization failed: ${error}`));
              closeAndSettle(() =>
                reject(new Error(`Authorization failed: ${error}`)),
              );
              return;
            }

            // ── Missing code ──────────────────────────────────────────────────
            if (!code) {
              await sendHtml(makeErrorHtml("No authorization code received."));
              closeAndSettle(() =>
                reject(new Error("No authorization code in callback")),
              );
              return;
            }

            // ── Token exchange ────────────────────────────────────────────────
            const exchangeRes = await fetch(`${apiUrl}/v1/auth/cli/token`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({
                code,
                code_verifier: codeVerifier,
                redirect_uri: redirectUri,
              }),
            });

            if (!exchangeRes.ok) {
              let errMsg = `Token exchange failed (HTTP ${exchangeRes.status})`;
              try {
                const body = (await exchangeRes.json()) as Record<
                  string,
                  unknown
                >;
                const desc = body["error_description"] ?? body["error"];
                if (typeof desc === "string") errMsg += `: ${desc}`;
              } catch {
                // ignore JSON parse failures on error responses
              }
              await sendHtml(makeErrorHtml(errMsg));
              closeAndSettle(() => reject(new Error(errMsg)));
              return;
            }

            const data = asTokenExchangeResponse(await exchangeRes.json());
            await sendHtml(SUCCESS_HTML);
            closeAndSettle(() => resolve(data));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            try {
              await sendHtml(makeErrorHtml(msg));
            } catch {
              // ignore: can't send error to browser at this point
            }
            closeAndSettle(() =>
              reject(err instanceof Error ? err : new Error(msg)),
            );
          }
        })();
      });
    },
  );
}
