import { requireEnv } from "@oxagen/config/env";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { imageGenerate } from "@oxagen/oxagen/contracts/image.generate";

// ── Handler ───────────────────────────────────────────────────────────────────
//
// Uses the Vercel AI SDK experimental_generateImage with @ai-sdk/openai when
// OPENAI_API_KEY is present. The AI SDK GeneratedFile type provides base64 and
// uint8Array — there is no url field. We encode the base64 bytes as a data URI.
//
// When OPENAI_API_KEY is absent this handler returns a typed placeholder —
// it never throws (policy §0.5).

export const imageGenerateHandler: CapabilityHandler<typeof imageGenerate> = async (
  input,
  ctx,
) => {
  const alt = input.alt ?? input.prompt.slice(0, 120);

  // Check for OPENAI_API_KEY without throwing — key is optional in the base schema.
  let openAiKey: string | undefined;
  try {
    const env = requireEnv(["OPENAI_API_KEY"] as const);
    openAiKey = env.OPENAI_API_KEY ?? undefined;
  } catch {
    // requireEnv throws if the key fails Zod validation; treat as absent.
    openAiKey = undefined;
  }

  if (!openAiKey) {
    console.log(
      `[image.generate] OPENAI_API_KEY not configured — returning placeholder for prompt: "${input.prompt}"`,
    );
    return {
      alt,
      placeholder: true,
      render: {
        componentId: "image-preview",
        props: { alt, placeholder: true, prompt: input.prompt },
      },
    };
  }

  try {
    // Dynamically import so the OpenAI SDK is only pulled in when needed.
    const { experimental_generateImage: generateImage } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");

    const client = createOpenAI({ apiKey: openAiKey });
    // DALL-E 3 is the only OpenAI model that supports experimental_generateImage.
    const imageModel = client.image("dall-e-3");

    const startedAt = Date.now();
    const result = await generateImage({
      model: imageModel,
      prompt: input.prompt,
      size: input.size ?? "1024x1024",
      n: 1,
    });

    const durationMs = Date.now() - startedAt;
    console.log(
      `[image.generate] generated in ${durationMs}ms for org=${ctx.orgId} ws=${ctx.workspaceId}`,
    );

    // GeneratedFile has base64 (string) and uint8Array. Encode as a data URI.
    const img = result.images[0];
    const dataUri: string | undefined = img?.base64
      ? `data:image/png;base64,${img.base64}`
      : undefined;

    return {
      dataUri,
      alt,
      placeholder: false,
      render: {
        componentId: "image-preview",
        props: { dataUri, alt, placeholder: false },
      },
    };
  } catch (err) {
    // Generation failed — return placeholder, never throw.
    const reason = err instanceof Error ? err.message : "unknown error";
    console.log(
      `[image.generate] generation failed (${reason}) — returning placeholder`,
    );
    return {
      alt,
      placeholder: true,
      render: {
        componentId: "image-preview",
        props: { alt, placeholder: true, errorReason: reason, prompt: input.prompt },
      },
    };
  }
};
