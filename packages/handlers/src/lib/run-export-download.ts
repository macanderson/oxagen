// The signed, expiring token behind a run export's download URL
// (`get_run_export`; spec §13.4, ADR-058).
//
// The URL has to work on a machine with no Oxagen session: the person who
// verifies a bundle is often an outside auditor. So the token carries the
// export, its tenant, the bundle digest and an expiry, signed with
// HMAC-SHA256 under the deployment's export signing secret. The API's
// download route trusts nothing else. The digest pins the link to the bytes
// the read described, and the domain prefix keeps a token minted for another
// export purpose from verifying here.
//
//   token = base64url(JSON claims) "." base64url(HMAC(domain "\n" claims))
import { createHmac, timingSafeEqual } from "node:crypto";
import { exportSigningSecret } from "../audit.events.export";

export const RUN_EXPORT_DOWNLOAD_DOMAIN = "oxagen.run-export-download.v1";

/** The API path the download route is mounted on (no session). */
export const RUN_EXPORT_DOWNLOAD_PATH = "/v1/run-exports/download";

export interface RunExportDownloadClaims {
  /** The export's public id (`rexp_…`). */
  exportId: string;
  orgId: string;
  workspaceId: string;
  bundleDigest: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function mac(encodedClaims: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`${RUN_EXPORT_DOWNLOAD_DOMAIN}\n${encodedClaims}`, "utf8")
    .digest();
}

export function mintRunExportDownloadToken(
  claims: RunExportDownloadClaims,
  secret: string,
): string {
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${mac(encoded, secret).toString("base64url")}`;
}

/**
 * The claims of a token this deployment signed and that has not expired, or
 * null. Every refusal is the same null: the route answers one 404 whatever
 * was wrong, so a probe learns nothing about which part failed.
 */
export function verifyRunExportDownloadToken(
  token: string,
  secret: string,
  nowSeconds: number,
): RunExportDownloadClaims | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const encoded = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = mac(encoded, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const c = claims as Record<string, unknown>;
  if (
    typeof c["exportId"] !== "string" ||
    typeof c["orgId"] !== "string" ||
    typeof c["workspaceId"] !== "string" ||
    typeof c["bundleDigest"] !== "string" ||
    typeof c["exp"] !== "number" ||
    !Number.isSafeInteger(c["exp"])
  ) {
    return null;
  }
  if (c["exp"] <= nowSeconds) return null;
  return {
    exportId: c["exportId"],
    orgId: c["orgId"],
    workspaceId: c["workspaceId"],
    bundleDigest: c["bundleDigest"],
    exp: c["exp"],
  };
}

/** The secret the token is signed under; shared with the audit export. */
export function runExportDownloadSecret(): string {
  return exportSigningSecret();
}

/**
 * The download URL for a token: absolute on the API's public origin when
 * `NEXT_PUBLIC_API_URL` is set, else the path, which the CLI resolves against
 * the API it is configured for.
 */
export function runExportDownloadUrl(token: string): string {
  const path = `${RUN_EXPORT_DOWNLOAD_PATH}?token=${encodeURIComponent(token)}`;
  const raw = process.env["NEXT_PUBLIC_API_URL"];
  if (!raw) return path;
  try {
    return new URL(path, new URL(raw).origin).toString();
  } catch {
    return path;
  }
}

export interface RunExportDownload {
  body: ReadableStream<Uint8Array>;
  bytes: number | null;
  bundleDigest: string;
  filename: string;
}

export interface OpenRunExportDownloadDeps {
  secret: () => string;
  nowSeconds: () => number;
  /** The row in the token's tenant, read inside that tenant's scope. */
  readRow: (claims: RunExportDownloadClaims) => Promise<{
    runPublicId: string;
    status: string;
    bundleRef: string | null;
    bundleDigest: string | null;
    bundleBytes: number | null;
  } | null>;
  getObject: (ref: string) => Promise<{
    body: ReadableStream<Uint8Array>;
    sizeBytes: number | null;
  }>;
}

/**
 * The bundle a download token names, or null for any token that is forged,
 * expired, or names an export that is not ready or whose digest has moved.
 */
export async function openRunExportDownload(
  token: string,
  deps: OpenRunExportDownloadDeps,
): Promise<RunExportDownload | null> {
  const claims = verifyRunExportDownloadToken(
    token,
    deps.secret(),
    deps.nowSeconds(),
  );
  if (!claims) return null;
  const row = await deps.readRow(claims);
  if (
    !row ||
    row.status !== "ready" ||
    row.bundleRef === null ||
    row.bundleDigest !== claims.bundleDigest
  ) {
    return null;
  }
  const object = await deps.getObject(row.bundleRef);
  return {
    body: object.body,
    bytes: row.bundleBytes ?? object.sizeBytes,
    bundleDigest: row.bundleDigest,
    filename: `${row.runPublicId}-${claims.exportId}.zip`,
  };
}
