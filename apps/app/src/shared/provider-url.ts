// A page an MCP provider publishes (#4132): its website, docs or source, and
// the sign-in page its authorization server names. The external targets the
// Add a provider wizard links to or points its popup at. A ProviderUrl is an
// https URL with no credentials, written as the URL parser writes it back; any
// other value is not linked and not opened.

declare const providerUrl: unique symbol;
export type ProviderUrl = string & { readonly [providerUrl]: true };

function isProviderUrl(href: string): href is ProviderUrl {
  const url = new URL(href);
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.href === href
  );
}

export function parseProviderUrl(raw: string | null): ProviderUrl | null {
  if (raw === null || !URL.canParse(raw)) return null;
  const href = new URL(raw).href;
  return isProviderUrl(href) ? href : null;
}
