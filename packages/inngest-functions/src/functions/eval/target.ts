import { z } from "zod";
import { generateObjectFor, selectModel, tierModelId } from "@oxagen/ai";
import type { Surface } from "@oxagen/telemetry";

// Runs one dataset item through the target under evaluation. v1 supports a bare
// model+prompt and an agent (evaluated through its published instruction prompt
// + configured model — the executor resolves those from the agent definition
// and passes them here). Everything goes through generateObjectFor so the
// target's tokens are metered like the judge's.

const targetAnswerSchema = z.object({
  answer: z.string().describe("The answer to the input."),
});

export interface RunTargetArgs {
  input: string;
  /** System instruction — target.systemPrompt (model) or agent instructions. */
  systemPrompt: string | null;
  /** Requested gateway model slug, or null to use the balanced tier. */
  modelId: string | null;
  telemetry: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    messageId: string | null;
  };
}

export interface RunTargetResult {
  output: string;
  /** The resolved gateway model id actually used (recorded per item). */
  modelId: string;
  usage: { promptTokens: number; completionTokens: number };
}

/** Produce the target's answer for one item. */
export async function runTarget(args: RunTargetArgs): Promise<RunTargetResult> {
  const modelId = args.modelId ?? tierModelId("balanced");
  const { object, usage } = await generateObjectFor({
    schema: targetAnswerSchema,
    system: args.systemPrompt ?? undefined,
    prompt: args.input,
    model: selectModel({ model: modelId }),
    telemetry: args.telemetry,
  });
  return {
    output: object.answer,
    modelId,
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    },
  };
}
