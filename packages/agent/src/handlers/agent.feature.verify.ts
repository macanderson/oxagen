import { z } from "zod";
import { generateObjectFor, selectModel, gatewayModels } from "@oxagen/ai";
import type { ModelMessage } from "@oxagen/ai";
import { storage } from "@oxagen/storage";
import type {
  AgentFeatureVerifyInput,
  AgentFeatureVerifyOutput,
} from "@oxagen/oxagen/contracts/agent.feature.verify";
import type { CapabilityContext } from "../types";

export type { AgentFeatureVerifyInput, AgentFeatureVerifyOutput };

// The judge's structured output. Kept separate from the contract output so the
// model is asked only for its judgement; the handler stamps judgeModel/builder.
const verdictSchema = z.object({
  verdict: z.enum(["pass", "fail", "inconclusive"]),
  confidence: z.number().min(0).max(1),
  observations: z.array(z.string()),
  issues: z.array(z.string()),
  reasoning: z.string(),
});

// Preference order when several independent vendors are available.
const JUDGE_PREFERENCE = ["anthropic", "openai", "google", "xai"] as const;

/** Resolve a model id's vendor from the catalog, falling back to the id prefix. */
function vendorOf(modelId: string): string | undefined {
  const found = gatewayModels.find((m) => m.id === modelId);
  if (found) return found.vendor;
  const prefix = modelId.split("/")[0];
  return gatewayModels.find((m) => m.vendor === prefix)?.vendor;
}

/**
 * Pick a vision-capable judge model from a DIFFERENT vendor than the builder so
 * the verdict is genuinely independent. When the builder model is unknown we
 * exclude 'anthropic' (the platform's default builder vendor) to bias toward
 * independence; callers should pass `builderModel` for a guaranteed split.
 */
export function pickJudgeModelId(builderModel: string | undefined): string {
  const vision = gatewayModels.filter((m) => m.capabilities.includes("vision"));
  const excludeVendor = builderModel ? vendorOf(builderModel) : "anthropic";
  const candidates = vision.filter((m) => m.vendor !== excludeVendor);
  for (const vendor of JUDGE_PREFERENCE) {
    // Prefer a reasoning+vision model from this vendor; else any vision one.
    const reasoning = candidates.find(
      (m) => m.vendor === vendor && m.capabilities.includes("reasoning"),
    );
    if (reasoning) return reasoning.id;
    const any = candidates.find((m) => m.vendor === vendor);
    if (any) return any.id;
  }
  return candidates[0]?.id ?? vision[0]?.id ?? "openai/gpt-5.2";
}

async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const JUDGE_SYSTEM =
  "You are an INDEPENDENT QA reviewer. You did NOT build this feature and must " +
  "not assume it works. Judge ONLY from the screenshots whether the stated " +
  "requirement is visibly satisfied. Be skeptical: a blank page, an error " +
  "message, a perpetual loading spinner, a 404/500, an empty state, or any " +
  "missing/garbled element is a FAIL — not a pass. Only return 'pass' when the " +
  "screenshots clearly and fully show the requirement met. List exactly what you " +
  "see (observations) and anything missing or broken (issues).";

/**
 * Independent cross-LLM verification of a built feature from its screenshots.
 */
export async function agentFeatureVerifyHandler(
  input: AgentFeatureVerifyInput,
  ctx: CapabilityContext,
): Promise<AgentFeatureVerifyOutput> {
  const judgeModelId = pickJudgeModelId(input.builderModel);

  // Read each private screenshot's bytes server-side (never a public URL) and
  // attach them as image parts the judge model reads directly.
  const adapter = storage();
  const imageParts = await Promise.all(
    input.screenshotKeys.map(async (key) => {
      const obj = await adapter.get(key);
      const bytes = await streamToBuffer(obj.body);
      return {
        type: "image" as const,
        image: new Uint8Array(bytes),
        mediaType: (obj.contentType ?? "image/png") as
          | "image/png"
          | "image/jpeg"
          | "image/webp",
      };
    }),
  );

  const checklistText = input.checklist?.length
    ? `\n\nConfirm each of these explicitly:\n${input.checklist.map((c) => `- ${c}`).join("\n")}`
    : "";

  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        ...imageParts,
        {
          type: "text",
          text:
            `Requirement the feature must satisfy:\n${input.requirement}` +
            checklistText +
            `\n\nThere ${input.screenshotKeys.length === 1 ? "is 1 screenshot" : `are ${input.screenshotKeys.length} screenshots`} above. ` +
            "Decide pass/fail/inconclusive strictly from what is visible.",
        },
      ],
    },
  ];

  const { object } = await generateObjectFor({
    schema: verdictSchema,
    model: selectModel({ model: judgeModelId }),
    system: JUDGE_SYSTEM,
    messages,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      messageId: ctx.messageId ?? ctx.requestId ?? null,
    },
  });

  return {
    verdict: object.verdict,
    confidence: object.confidence,
    judgeModel: judgeModelId,
    builderModel: input.builderModel ?? null,
    observations: object.observations,
    issues: object.issues,
    reasoning: object.reasoning,
  };
}
