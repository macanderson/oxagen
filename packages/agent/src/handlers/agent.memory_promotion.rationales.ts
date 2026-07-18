import { z } from "zod";
import { generateObjectFor, selectModel } from "@oxagen/ai";
import type { CapabilityContext } from "../types";
import { getMemoryById, type MemoryRecord } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryPromotionRationalesInput,
  AgentMemoryPromotionRationalesOutput,
} from "@oxagen/oxagen/contracts/agent.memory_promotion.rationales";

export type {
  AgentMemoryPromotionRationalesInput,
  AgentMemoryPromotionRationalesOutput,
};

/** Contract cap on a rationale's length. */
const MAX_RATIONALE_LEN = 200;

const draftSchema = z.object({
  rationales: z
    .array(z.string())
    .describe("Candidate rationales, most fitting first"),
});

type TargetClass = AgentMemoryPromotionRationalesInput["toClass"];

/** Rank on the confidence ladder — lets us tell a promotion from a demotion. */
const CLASS_RANK: Record<string, number> = {
  OBSERVATION: 0,
  RULE: 1,
  FACT: 2,
};

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_RATIONALE_LEN);
}

/** Clamp, trim, drop empties, dedupe, and cap to `count` — enforces the contract. */
function clamp(raw: string[], count: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const n = normalize(r);
    if (n.length === 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * Deterministic rationales grounded in the memory's citation signals, used when
 * the model call fails so the capability degrades gracefully instead of
 * erroring. Direction (promotion vs demotion) is inferred from the memory's
 * current class vs the target class.
 */
function buildFallbackRationales(
  memory: MemoryRecord,
  toClass: TargetClass,
  count: number,
): string[] {
  const { citationCount, influenceCount, violationCount, confidenceScore } =
    memory;
  const target = toClass.toLowerCase();
  const isDemotion = CLASS_RANK[toClass]! < CLASS_RANK[memory.memoryClass]!;

  const candidates: string[] = [
    `Cited ${citationCount} time${citationCount === 1 ? "" : "s"} with ${influenceCount} influential use${influenceCount === 1 ? "" : "s"} — consistently load-bearing.`,
  ];

  if (isDemotion) {
    candidates.push(
      `Low influence (${influenceCount} of ${citationCount} citations) — better tracked as a${target === "observation" ? "n" : ""} ${target} than enforced.`,
    );
    if (violationCount > 0) {
      candidates.push(
        `${violationCount} recorded violation${violationCount === 1 ? "" : "s"} — this is not being reliably followed, so step it down to a ${target}.`,
      );
    }
    candidates.push(
      `Confidence ${confidenceScore.toFixed(0)} no longer supports enforcing this — reclassify as a ${target}.`,
    );
  } else {
    candidates.push(
      `Enough citation pressure (${citationCount} citation${citationCount === 1 ? "" : "s"}, ${influenceCount} influential) to codify this as a ${target}.`,
    );
    if (toClass === "FACT") {
      candidates.push(
        `Human-confirmed and heavily cited — safe to lock in as a fact.`,
      );
    } else {
      candidates.push(
        `Confidence ${confidenceScore.toFixed(0)} after ${citationCount} citation${citationCount === 1 ? "" : "s"} supports enforcing this as a rule.`,
      );
    }
  }

  return clamp(candidates, count);
}

/**
 * agent.memory.promotion.rationales — draft short, context-grounded rationales
 * for a promotion or demotion so the human can pick one instead of typing. Loads
 * the memory's lesson + citation signals, asks a low-cost model (metered via
 * @oxagen/ai) for candidates, and falls back to deterministic templates if the
 * model call fails (docs/specs/two-axis-memory §7c).
 */
export async function agentMemoryPromotionRationalesHandler(
  input: AgentMemoryPromotionRationalesInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryPromotionRationalesOutput> {
  if (!isKnowledgeGraphEnabled()) {
    throw new Error(
      "Knowledge graph is not configured; agent.memory.promotion.rationales has no memory to ground on.",
    );
  }

  const memory = await getMemoryById(input.memoryId);
  if (!memory) {
    throw new Error(`Memory ${input.memoryId} not found in this workspace.`);
  }

  const isDemotion =
    CLASS_RANK[input.toClass]! < CLASS_RANK[memory.memoryClass]!;
  const direction = isDemotion ? "demotion" : "promotion";

  const prompt = [
    `A workspace memory is being considered for ${direction} to ${input.toClass}.`,
    ``,
    `Lesson: "${memory.lesson}"`,
    `Current class: ${memory.memoryClass}`,
    `Kind: ${memory.memoryKind}`,
    `Citations: ${memory.citationCount} (influential: ${memory.influenceCount}, violations: ${memory.violationCount})`,
    `Confidence: ${memory.confidenceScore.toFixed(0)}/100`,
    ``,
    `Draft exactly ${input.count} short (max ${MAX_RATIONALE_LEN} characters) rationales a reviewer could record for this ${direction}. Ground each in the lesson and the citation signals above; make them distinct. Most fitting first.`,
  ].join("\n");

  try {
    const { object } = await generateObjectFor({
      schema: draftSchema,
      system:
        "You draft concise, evidence-grounded rationales for changing the epistemic class of an agent memory. Each rationale is one sentence, references the memory's actual usage signals, and never invents facts not present in the input.",
      prompt,
      temperature: 0.5,
      // Fast/cheap tier — drafting a few short sentences needs no reasoning model.
      model: selectModel({ tier: "fast" }),
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        messageId: ctx.messageId ?? ctx.requestId ?? null,
      },
    });
    const rationales = clamp(object.rationales, input.count);
    if (rationales.length === 0) {
      return {
        rationales: buildFallbackRationales(memory, input.toClass, input.count),
      };
    }
    return { rationales };
  } catch (err) {
    // Degrade gracefully: a model/gateway failure must not fail the capability.
    console.warn(
      "suggest_promotion_rationales: model draft failed, using fallback",
      err,
    );
    return {
      rationales: buildFallbackRationales(memory, input.toClass, input.count),
    };
  }
}
