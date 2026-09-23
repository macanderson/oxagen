/** Pure email helpers shared by the SSO policy and domain guard. */

/** The email's domain, lowercased, or null for a malformed address. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}
