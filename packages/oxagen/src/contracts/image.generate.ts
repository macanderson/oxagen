import { z } from "zod";
import { registerCapability } from "../registry";

const renderDirectiveSchema = z.object({
  componentId: z.string(),
  props: z.record(z.unknown()),
});

export const imageGenerate = registerCapability({
  name: "image.generate",
  domain: "image",
  description:
    "Generate an image from a natural-language prompt using the OpenAI image generation API " +
    "(via the Vercel AI Gateway, default model openai/gpt-image-1). " +
    "When AI_GATEWAY_API_KEY is not configured, returns a typed placeholder result with a render " +
    "directive that shows an empty-state in chat — never throws. " +
    "Returns the image URL or data URI, alt text, and a render directive for the image-preview " +
    "chat component.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "generation",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    /** Natural-language description of the image to generate. */
    prompt: z.string().min(1),
    /**
     * Optional accessible alt text for the generated image.
     * If omitted the handler derives one from the prompt.
     */
    alt: z.string().optional(),
    /**
     * Image size to request.
     * Only supported sizes for gpt-image-1 are: 1024x1024, 1792x1024, 1024x1792.
     */
    size: z.enum(["1024x1024", "1792x1024", "1024x1792"]).optional(),
  }),
  output: z.object({
    /**
     * Base-64 data URI (data:image/png;base64,...) of the generated image.
     * Present when generation succeeded.
     */
    dataUri: z.string().optional(),
    /** Accessible alt text for the image. */
    alt: z.string(),
    /**
     * True when AI_GATEWAY_API_KEY is not configured or generation failed.
     * The render directive will show an empty-state component.
     */
    placeholder: z.boolean(),
    /** Render directive instructing the chat UI to show image-preview. */
    render: renderDirectiveSchema,
  }),
});

export type ImageGenerateInput = z.output<typeof imageGenerate.input>;
export type ImageGenerateOutput = z.output<typeof imageGenerate.output>;
