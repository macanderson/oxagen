// badge.ts: the README badge that shows a work item's done-record verdict.
//
// A badge URL carries a token, not a bare work item id. The token names the
// organization, the workspace, and the work item, and the done attestation key
// signs it. The badge route reads the verdict inside that tenant scope, so it
// never looks a work item up across tenants, and a guessed id shows nothing.
// The token does not expire: a README keeps its badge until the key rotates.
import { sign, verify } from "node:crypto";
import { jcsBytes } from "@oxagen/run-evidence";
import type { DoneVerdict, WorkItemId } from "../types";
import { donePublicKey, type DoneAttestationKey } from "./key";

/** Where the API serves the badge. The token and `.svg` follow it. */
export const DONE_BADGE_PATH = "/v1/work/done/badge";

/** Where the API serves the public key document. */
export const DONE_KEY_PATH = "/v1/work/done/key";

const TOKEN_DOMAIN = "oxagen.work-done-badge.v1\n";
const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORK_ITEM_ID = /^wi_[0-9A-Za-z]{1,64}$/;

/** The work item a badge token points at. */
export interface DoneBadgeClaims {
  orgId: string;
  workspaceId: string;
  item: WorkItemId;
}

/** What a badge shows: a verdict, or `none` when the item has no done record. */
export type DoneBadgeState = DoneVerdict | "none";

function claimsValid(claims: DoneBadgeClaims): boolean {
  return (
    UUID.test(claims.orgId) &&
    UUID.test(claims.workspaceId) &&
    WORK_ITEM_ID.test(claims.item)
  );
}

function signedBytes(claimsPart: string): Buffer {
  return Buffer.from(`${TOKEN_DOMAIN}${claimsPart}`, "utf8");
}

/** A badge token for one work item, signed with the done attestation key. */
export function mintDoneBadgeToken(
  claims: DoneBadgeClaims,
  key: DoneAttestationKey,
): string {
  if (!claimsValid(claims)) {
    throw new TypeError(
      "done badge: orgId and workspaceId must be lowercase UUIDs, and item a work item id",
    );
  }
  const body = jcsBytes({
    v: TOKEN_VERSION,
    org: claims.orgId,
    ws: claims.workspaceId,
    item: claims.item,
  });
  const claimsPart = Buffer.from(body).toString("base64url");
  const sig = sign(null, signedBytes(claimsPart), key.privateKey);
  return `${claimsPart}.${sig.toString("base64url")}`;
}

function readClaims(claimsPart: string): DoneBadgeClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, org, ws, item } = value as Record<string, unknown>;
  if (v !== TOKEN_VERSION) return null;
  if (typeof org !== "string" || typeof ws !== "string" || typeof item !== "string") {
    return null;
  }
  const claims = { orgId: org, workspaceId: ws, item: item as WorkItemId };
  return claimsValid(claims) ? claims : null;
}

/**
 * The claims of a badge token when the key behind `publicKeyPem` signed it, or
 * null. Every refusal is the same null, so a caller answers every bad token
 * the same way.
 */
export function readDoneBadgeToken(
  token: string,
  publicKeyPem: string,
): DoneBadgeClaims | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [claimsPart, sigPart] = parts as [string, string];
  if (!BASE64URL.test(claimsPart) || !BASE64URL.test(sigPart)) return null;
  const sig = Buffer.from(sigPart, "base64url");
  if (sig.length !== 64) return null;
  if (!verify(null, signedBytes(claimsPart), donePublicKey(publicKeyPem), sig)) {
    return null;
  }
  return readClaims(claimsPart);
}

/** The badge URL for a token. `apiBaseUrl` is the API's origin. */
export function doneBadgeUrl(apiBaseUrl: string, token: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}${DONE_BADGE_PATH}/${token}.svg`;
}

const LABEL = "Oxagen done";
const CHAR_WIDTH = 7;
const PADDING = 10;

const STATE_TEXT: Record<DoneBadgeState, string> = {
  pending: "pending",
  held: "held",
  proven: "proven",
  broken: "broken",
  none: "no record",
};

// The light-theme state tokens from the brand system. A README renders on
// white, and white text on each clears 4.5:1.
const STATE_COLOR: Record<DoneBadgeState, string> = {
  pending: "#2E6BA8",
  held: "#2F7D52",
  proven: "#1F7676",
  broken: "#992F28",
  none: "#71717A",
};

function textWidth(text: string): number {
  return text.length * CHAR_WIDTH + PADDING * 2;
}

/** The badge SVG for a state. Every string in it is a constant. */
export function renderDoneBadge(state: DoneBadgeState): string {
  const value = STATE_TEXT[state];
  const color = STATE_COLOR[state];
  const labelWidth = textWidth(LABEL);
  const valueWidth = textWidth(value);
  const width = labelWidth + valueWidth;
  const title = `${LABEL}: ${value}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    `<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r)">`,
    `<rect width="${labelWidth}" height="20" fill="#27272A"/>`,
    `<rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>`,
    `</g>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${labelWidth / 2}" y="14">${LABEL}</text>`,
    `<text x="${labelWidth + valueWidth / 2}" y="14">${value}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
