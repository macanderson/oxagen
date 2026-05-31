import { embed } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { requireEnv } from "@oxagen/config/env";

// Match the 1536-dim AgentMemory vector index. Swap models requires a
// re-index, so we pin here and treat the index name as the contract.
const MODEL = "text-embedding-3-small";

export async function embedText(text: string): Promise<number[]> {
  const env = requireEnv(["OPENAI_API_KEY"] as const);
  const provider = env.OPENAI_API_KEY ? createOpenAI({ apiKey: env.OPENAI_API_KEY }) : createOpenAI();
  const { embedding } = await embed({ model: provider.embedding(MODEL), value: text });
  return embedding;
}
