import type { CapabilityHandler } from "@oxagen/oxagen";
import { mermaidGenerate } from "@oxagen/oxagen/contracts/mermaid.generate";
import { logger } from "./logger";

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

export const mermaidGenerateHandler: CapabilityHandler<typeof mermaidGenerate> = async (
  input,
  ctx,
) => {
  validateDiagramSource(input.diagram);

  const theme = input.theme ?? "default";

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      titleLen: input.title.length,
      sourceLen: input.diagram.length,
      theme,
    },
    "mermaid.generate: returning render directive",
  );

  return {
    title: input.title,
    source: input.diagram,
    render: {
      componentId: "mermaid-diagram",
      props: {
        source: input.diagram,
        title: input.title,
        theme,
      },
    },
  };
};
