// secrets.ts: the secret and personal-data scanner every steering check and
// every steering PR shares. It moved here from @oxagen/handlers unchanged, and
// handlers re-exports it for the callers that still import it there.
//
// Secrets, mirroring the detector Stella's `stella context validate` reuses
// (stella-learn/src/redact.rs): a vendor-prefixed token, a JWT by shape, a
// long mixed-case opaque blob, a value after a sensitive key name, a PEM
// block. PII: an email address, a US social security number, a payment card
// number that passes Luhn.
const SECRET_PREFIXES = [
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "xoxs-",
  "npm_",
  "dop_v1_",
  "doo_v1_",
  "sk_live_",
  "sk_test_",
  "rk_live_",
  "sk-",
  "AKIA",
  "ASIA",
  "AIza",
  "ya29.",
  "SG.",
  "hf_",
  "shpat_",
  "sq0atp-",
  "sq0csp-",
];
const SENSITIVE_KEY_MARKERS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesskey",
  "access_key",
  "privatekey",
  "private_key",
  "credential",
  "authorization",
  "auth_token",
  "bearer",
  "session_id",
  "client_secret",
];
const TOKEN = /[A-Za-z0-9_\-./+~]+/g;

function isJwt(token: string): boolean {
  const parts = token.split(".");
  return (
    parts.length === 3 &&
    parts[0]!.startsWith("eyJ") &&
    parts[0]!.length >= 8 &&
    parts[1]!.length >= 8 &&
    parts[2]!.length > 0
  );
}

function isHighEntropyBlob(token: string): boolean {
  if (token.length < 32 || token.includes("/") || token.includes("."))
    return false;
  if (!/^[A-Za-z0-9_\-+~]+$/.test(token)) return false;
  return /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

function isSecretToken(token: string): boolean {
  if (token.length < 8) return false;
  if (
    SECRET_PREFIXES.some(
      (p) => token.startsWith(p) && token.length > p.length + 4,
    )
  ) {
    return true;
  }
  return isJwt(token) || isHighEntropyBlob(token);
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The findings in one text, each naming what was found. */
export function findSecretsAndPii(text: string): string[] {
  const findings: string[] = [];
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text))
    findings.push("private key block");
  for (const token of text.match(TOKEN) ?? []) {
    if (isSecretToken(token)) {
      findings.push("credential token");
      break;
    }
  }
  const keyed =
    /([A-Za-z_][A-Za-z0-9_-]*)\s*[=:]\s*["']?([A-Za-z0-9_\-./+~]{8,})/g;
  for (const m of text.matchAll(keyed)) {
    const key = m[1]!.toLowerCase();
    if (
      !key.endsWith("_env") &&
      SENSITIVE_KEY_MARKERS.some((k) => key.includes(k))
    ) {
      findings.push(`value after sensitive key ${m[1]}`);
      break;
    }
  }
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text))
    findings.push("email address");
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text))
    findings.push("US social security number");
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      findings.push("payment card number");
      break;
    }
  }
  return findings;
}
