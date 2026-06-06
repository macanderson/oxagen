import type { BrowserContext } from "@playwright/test";

// Programmatic login for E2E: calls the real Better Auth sign-in endpoint
// with email + password, extracts the returned session cookies, and injects
// them into the Playwright browser context.
//
// This replaces the old approach of manually signing a cookie with HMAC-SHA256,
// which required the test process to hold the same BETTER_AUTH_SECRET as the
// running server. The old approach broke whenever the shell exported a partially-
// corrupted value for the secret (common in zsh due to `=` in base64 secrets).
//
// By calling the real sign-in API we side-step secret replication entirely: the
// server produces the signed cookies itself and we inject them verbatim.

export async function loginAs(
  context: BrowserContext,
  email: string,
  password: string,
  baseUrl: string = "http://localhost:3000",
): Promise<void> {
  const signInUrl = new URL("/api/auth/sign-in/email", baseUrl).toString();

  const res = await fetch(signInUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    // Do NOT follow redirects — we want the raw Set-Cookie headers.
    redirect: "manual",
  });

  if (!res.ok && res.status !== 302) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(
      `loginAs: sign-in failed for ${email} — status ${res.status}: ${body}`,
    );
  }

  // Collect all Set-Cookie headers from the sign-in response.
  const setCookies: string[] = [];
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      setCookies.push(value);
    }
  });

  if (setCookies.length === 0) {
    throw new Error(
      `loginAs: sign-in for ${email} returned no Set-Cookie headers — check credentials`,
    );
  }

  const url = new URL(baseUrl);
  const domain = url.hostname;

  // Parse each Set-Cookie string and inject it into the browser context.
  const cookies: Parameters<typeof context.addCookies>[0] = [];
  for (const raw of setCookies) {
    const parts = raw.split(";").map((p) => p.trim());
    const [nameValue, ...attrs] = parts;
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx < 1) continue;
    const name = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();

    // Parse attributes.
    let path = "/";
    let maxAge: number | undefined;
    let httpOnly = false;
    let secure = false;
    let sameSite: "Strict" | "Lax" | "None" = "Lax";

    for (const attr of attrs) {
      const lower = attr.toLowerCase();
      if (lower.startsWith("path=")) path = attr.slice(5);
      else if (lower.startsWith("max-age=")) maxAge = parseInt(attr.slice(8), 10);
      else if (lower === "httponly") httpOnly = true;
      else if (lower === "secure") secure = false; // E2E runs over http
      else if (lower.startsWith("samesite=")) {
        const sv = attr.slice(9).trim().toLowerCase();
        sameSite = sv === "strict" ? "Strict" : sv === "none" ? "None" : "Lax";
      }
    }

    const expires = maxAge !== undefined
      ? Math.floor(Date.now() / 1000) + maxAge
      : Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;

    cookies.push({
      name,
      value,
      domain,
      path,
      httpOnly,
      secure,
      sameSite,
      expires,
    });
  }

  await context.addCookies(cookies);
}

// Password used for all seeded E2E test accounts.
// Must match what seedPlugin / setupAgentRuntimeFixture seed into auth.accounts.
export const E2E_TEST_PASSWORD = "E2eTestPassword123!";
