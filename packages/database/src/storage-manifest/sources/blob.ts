// Blob source — enumerates the blob-storage asset kinds and their Postgres
// reference tables.
//
// The blob store (Vercel Blob via @oxagen/storage) holds binary bytes only; the
// Postgres row (URL + metadata) is the source of truth (four-store boundary).
// There is no queryable "schema" for blobs, so the asset-kind inventory is an
// explicit, hand-verified map grounded in two committed sources:
//   1. content.generated_assets.kind CHECK constraint
//      (packages/database/src/schema/content.ts): the private-asset kinds
//      image | video | document | spreadsheet | presentation | pdf | archive.
//   2. The avatar/logo columns (avatar_url) on auth.users / org.organizations /
//      workspace.workspaces / agent.agents — public blobs whose URL is stored
//      directly on the owning row (no generated_assets row).
// The @oxagen/storage layer's own AssetKind union (avatar|image|document|video)
// is the public-upload validation vocabulary; it is a subset of the above and
// is not re-enumerated separately.
//
// This map is the documented override the task calls for. When a new asset kind
// or reference table lands, update it here AND in GENERATED_ASSET_KINDS below.
//
// CAVEAT — the suite's blob test compares BLOB_ASSETS against
// GENERATED_ASSET_KINDS, and both live in this file, so it catches only an
// edit that updates one and forgets the other. It does NOT read the real
// generated_assets_kind_check constraint in schema/content.ts, so a kind added
// to that constraint and not to this file passes the suite silently. Adding a
// kind to the CHECK therefore still requires a hand edit here.

import type { ManifestColumn, ManifestTable } from "../types";

/** Store-qualified id for a blob asset kind, e.g. "blob:generated_asset". */
export function blobAssetId(kind: string): string {
  return `blob:${kind}`;
}

interface BlobAssetSpec {
  /** Logical asset-kind id used in the manifest table id. */
  kind: string;
  /** The concrete generated_assets.kind values this entry covers (if any). */
  kinds: string[];
  /** Postgres table ids that hold the reference row(s), sorted. */
  referencedBy: string[];
  /** Visibility: public CDN blob vs access-controlled private blob. */
  access: "public" | "private";
  description: string;
}

/**
 * The blob asset inventory. `generated_asset` is the private, access-controlled
 * media family (one Postgres table, `content.generated_assets`, discriminates
 * by its own `kind` column); `avatar` is the public profile-image family whose
 * URL lives directly on the owning entity's row.
 */
export const BLOB_ASSETS: readonly BlobAssetSpec[] = [
  {
    kind: "generated_asset",
    kinds: [
      "image",
      "video",
      "document",
      "spreadsheet",
      "presentation",
      "pdf",
      "archive",
    ],
    referencedBy: ["postgres:content.generated_assets"],
    access: "private",
    description:
      "Generated + uploaded media (chat attachments, exports, agent output); " +
      "content.generated_assets is the source-of-truth reference row.",
  },
  {
    kind: "avatar",
    kinds: ["avatar"],
    referencedBy: [
      "postgres:agent.agents",
      "postgres:auth.users",
      "postgres:org.organizations",
      "postgres:workspace.workspaces",
    ],
    access: "public",
    description:
      "Public profile/logo images; the blob URL is stored on the owning " +
      "entity's avatar_url column (no generated_assets row).",
  },
];

/**
 * The concrete generated_assets.kind CHECK-constraint values, exported so a
 * drift test can assert this map covers exactly the kinds the schema allows.
 */
export const GENERATED_ASSET_KINDS: readonly string[] = [
  "archive",
  "document",
  "image",
  "pdf",
  "presentation",
  "spreadsheet",
  "video",
];

/**
 * Build the blob ManifestTables. Blobs have no columns; the referencing tables
 * and access model live in `meta`. Every blob entry is in the `content` domain
 * (the shared media domain), assigned directly here rather than through
 * domains.ts — blob kinds are a fixed two-entry inventory, so there is nothing
 * to look up. Deterministic — a pure function of the static inventory above.
 */
export function collectBlobAssets(): ManifestTable[] {
  const tables: ManifestTable[] = BLOB_ASSETS.map((asset) => {
    const columns: ManifestColumn[] = [];
    const meta: Record<string, string> = {
      driver: "vercel-blob",
      access: asset.access,
      assetKinds: [...asset.kinds].sort().join(","),
      referencedBy: [...asset.referencedBy].sort().join(","),
      description: asset.description,
    };
    return {
      id: blobAssetId(asset.kind),
      store: "blob" as const,
      // Blob media is org/workspace-scoped through its Postgres reference row's
      // RLS; the bytes themselves carry no tenant column, so the manifest marks
      // blob entries tenant-scoped (isolation is enforced at the reference row).
      domain: "content",
      name: asset.kind,
      tenantScoped: true,
      columns,
      meta,
    };
  });
  tables.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tables;
}
