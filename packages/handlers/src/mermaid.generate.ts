import type { CapabilityHandler } from "@oxagen/oxagen";
import { mermaidGenerate } from "@oxagen/oxagen/contracts/mermaid.generate";
import { logger } from "./logger";
import { persistGeneratedAsset } from "./generated-asset.persist";

// ── Source sanitisation ───────────────────────────────────────────────────────
// The Mermaid source is rendered entirely in the browser by the client component.
// We do minimal server-side validation: reject empty/overlong input.
// The 50,000-character cap is already enforced by the contract Zod schema;
// this guard is defence-in-depth for callers that bypass the schema parse.

const MAX_SOURCE_LENGTH = 50_000;

function validateDiagramSource(source: string): void {
  if (!source.trim()) {
    throw new Error("mermaid.generate: diagram source must not be blank");
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error(
      `mermaid.generate: diagram source exceeds the ${MAX_SOURCE_LENGTH}-character cap`,
    );
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const mermaidGenerateHandler: CapabilityHandler<
  typeof mermaidGenerate
> = async (input, ctx) => {
  validateDiagramSource(input.diagram);

  const theme = input.theme ?? "default";

  // ── Persist the diagram source as a conversation file ─────────────────────
  // Mermaid renders to SVG in the BROWSER, so the server can never persist the
  // rendered graphic — the durable artifact is the .mmd source itself, stored
  // as a `document` asset via the shared persistGeneratedAsset seam
  // (conversation linkage resolves from ctx.messageId inside the seam).
  // Persistence is strictly non-fatal: the render directive below is always
  // returned, and any failure only surfaces as `persistWarning` in the output.
  let assetPublicId: string | undefined;
  let serveUrl: string | undefined;
  let persistWarning: string | undefined;

  if (!ctx.userId) {
    persistWarning =
      "Diagram source was not saved to conversation files: no user identity in the request context.";
  } else {
    try {
      const asset = await persistGeneratedAsset({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        kind: "document",
        accessPolicy: "org",
        bytes: new TextEncoder().encode(input.diagram),
        // IANA-registered Mermaid media type; maps to the .mmd extension in
        // both the storage-key and display-filename derivations.
        mimeType: "text/vnd.mermaid",
        prompt: `Generate mermaid diagram: ${input.title}`,
        // No LLM call happens here — the source arrives pre-authored.
        model: "local",
        displayName: input.title,
        messageId: ctx.messageId ?? undefined,
      });
      assetPublicId = asset.publicId;
      serveUrl = asset.serveUrl;
    } catch (err) {
      logger.warn(
        {
          err,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          title: input.title,
        },
        "mermaid.generate: source persistence failed (non-fatal) — returning inline result only",
      );
      persistWarning =
        "Diagram was generated but its source could not be saved to conversation files.";
    }
  }

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      titleLen: input.title.length,
      sourceLen: input.diagram.length,
      theme,
      assetPublicId: assetPublicId ?? null,
    },
    "mermaid.generate: returning render directive",
  );

  return {
    title: input.title,
    source: input.diagram,
    ...(assetPublicId !== undefined ? { assetPublicId } : {}),
    ...(serveUrl !== undefined ? { serveUrl } : {}),
    ...(persistWarning !== undefined ? { persistWarning } : {}),
    render: {
      componentId: "mermaid-diagram",
      props: {
        source: input.diagram,
        title: input.title,
        theme,
        ...(serveUrl !== undefined ? { sourceUrl: serveUrl } : {}),
        ...(assetPublicId !== undefined ? { assetPublicId } : {}),
      },
    },
  };
};
