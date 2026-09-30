// The origin an MCP authorization server is sent back to (#4132): the OAuth
// callback and Oxagen's client metadata document are both named on it, and an
// authorization server compares the two, so both must come from here.
//
// The origin is the one the person is using when that is one of the app's own
// hosts (ADR-215 serves three) or a local one, so the popup lands on the host
// that set the flow's cookie and where the wizard can hear it. Any other host
// falls back to the configured origin: a forwarded host is the client's to
// spell, and an authorization server must never be told to trust it.
import { getMetadataBase } from "@/shared/app-url";
import { isAppHost } from "@/shared/canonical-host";

/** Reads one request header, or null when it is absent. */
export type HeaderRead = (name: string) => string | null;

export function appOriginOf(header: HeaderRead): string {
  const base = getMetadataBase();
  const host = header("x-forwarded-host") ?? header("host");
  if (host === null) return base.origin;
  const hostname = host.split(":")[0] ?? "";
  const local = hostname === "localhost" || hostname === "127.0.0.1";
  if (local) {
    return `${header("x-forwarded-proto") ?? "http"}://${host}`;
  }
  if (host === base.host) {
    return `${header("x-forwarded-proto") ?? "https"}://${host}`;
  }
  // A production app host is always served over https, whatever the proxy
  // says it received.
  return isAppHost(hostname) ? `https://${hostname}` : base.origin;
}
