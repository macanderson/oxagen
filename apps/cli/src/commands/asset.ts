/**
 * `oxagen asset upload <url>` — ingest a binary asset from a public URL into
 * object storage over the org-scoped /v1 API. Thin shell over the asset.upload
 * capability so the CLI stays in parity with the API, MCP, and agent surfaces.
 *
 * With `--conversation <id>` the upload is recorded as a private chat/agent
 * attachment (`source: "user_upload"`) linked to that conversation and servable
 * via the access-controlled /api/v1/assets/:publicId route — otherwise it is a
 * pure public-blob ingest with no DB row.
 *
 * Output discipline (ADR-023 §4): `--json` emits one single-line JSON value on
 * stdout; pretty mode prints the upload summary on stdout; a bad `--kind` exits
 * 2 (usage), an API failure exits 1 — both as uniform stderr error lines.
 */
import { apiPostOrThrow } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

interface AssetUploadResponse {
  url: string;
  key: string;
  contentType: string;
  bytes: number;
  publicId: string | null;
}

type AssetKind = "avatar" | "image" | "document" | "video";

const KINDS: AssetKind[] = ["avatar", "image", "document", "video"];

export async function handleAssetUpload(
  url: string,
  opts: {
    kind?: string;
    filename?: string;
    conversation?: string;
    json?: boolean;
  },
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const kind = (opts.kind ?? "image") as AssetKind;
  if (!KINDS.includes(kind)) {
    process.exitCode = 2;
    out.error(
      `Invalid --kind "${opts.kind}". Use one of: ${KINDS.join(", ")}.`,
      "usage",
    );
    return;
  }

  const body: Record<string, unknown> = { sourceUrl: url, kind };
  if (opts.filename) body.filename = opts.filename;
  if (opts.conversation) {
    // A conversation attachment implies the user_upload source.
    body.source = "user_upload";
    body.conversationId = opts.conversation;
  }

  let res: AssetUploadResponse;
  try {
    res = await apiPostOrThrow<AssetUploadResponse>("asset/upload", body);
  } catch (err) {
    out.error(err, "api");
    return;
  }

  out.data(res, () => prettyAsset(kind, res));
}

function prettyAsset(kind: AssetKind, res: AssetUploadResponse): string {
  const lines = [
    `Uploaded ${kind} (${res.bytes} bytes, ${res.contentType})`,
    `  key: ${res.key}`,
    `  url: ${res.url}`,
  ];
  if (res.publicId) lines.push(`  id:  ${res.publicId}`);
  return lines.join("\n");
}
