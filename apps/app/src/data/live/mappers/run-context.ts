// get_run_context → the Run page's context window view (ADR-193, #3894).
// Field for field, except the call's id, which the view names `callRef`
// because an app field ending in `Id` is a public id (INV-11).
import type { RunContextGetOutput } from "@oxagen/oxagen/contracts/run.context.get";
import type { z } from "zod";
import type { RunContext } from "@/data/contracts/run-context";

export function toRunContext(
  out: RunContextGetOutput,
): z.input<typeof RunContext> {
  return {
    source: out.source,
    windows: out.windows.map((window) => ({
      seq: window.seq,
      responseSeq: window.responseSeq,
      callRef: window.modelCallId,
      provider: window.provider,
      model: window.model,
      promptTokens: window.promptTokens,
      bytes: window.bytes,
      blocks: window.blocks.map((block) => ({
        kind: block.kind,
        bytes: block.bytes,
        items: block.items,
        tokens: block.tokens,
      })),
    })),
    unmeasured: out.unmeasured,
    assemblies: out.assemblies.map((assembly) => ({
      seq: assembly.seq,
      budgetTokens: assembly.budgetTokens,
      spentTokens: assembly.spentTokens,
      included: assembly.included,
      cut: assembly.cut,
      textDigest: assembly.textDigest,
    })),
    complete: out.complete,
  };
}
