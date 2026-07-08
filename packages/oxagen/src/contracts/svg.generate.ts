import { z } from "zod";
import { registerCapability } from "../registry";

// ── Render directive schema (mirrors RenderDirective in stream-event-types) ───

const renderDirectiveSchema = z.object({
  componentId: z.string(),
  props: z.record(z.unknown()),
});

// ── Contract registration ─────────────────────────────────────────────────────

export const svgGenerate = registerCapability({
  name: "generate_svg",
  domain: "svg",
  description:
    "Generate clean, sanitized, inline SVG markup from a natural-language prompt. " +
    "The SVG uses currentColor and CSS custom properties so it adapts to light and dark mode. " +
    "Script tags and inline event handlers are stripped before the output is returned. " +
    "The generated SVG is also persisted as a conversation file (generated_assets row + " +
    "blob storage) so it appears in the Conversation Files panel; persistence failures " +
    "never fail the generation. " +
    "Returns the SVG markup, a title, the persisted asset's serve URL, and a render " +
    "directive so the output renders inline in chat.",
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
    /** Natural-language description of the SVG to generate. */
    prompt: z.string().min(1),
    /**
     * Optional title for the SVG — used as the accessible <title> element
     * and in the chat component heading. If omitted the model derives one.
     */
    title: z.string().optional(),
    /**
     * Optional width hint in pixels. The model may produce any viewBox but
     * this hint nudges proportions. Defaults to 400.
     */
    width: z.number().int().positive().optional(),
    /**
     * Optional height hint in pixels. Defaults to 400.
     */
    height: z.number().int().positive().optional(),
  }),
  output: z.object({
    /** Sanitized inline SVG markup string (rendered client-side via an <img> data URI). */
    svg: z.string().min(1),
    /** Human-readable title for the graphic. */
    title: z.string().min(1),
    /**
     * Public id ("gen_…") of the persisted generated_assets row. Absent when
     * persistence was skipped (generation failed / no user identity) or failed.
     */
    assetPublicId: z.string().optional(),
    /**
     * Access-controlled serving URL (/api/v1/assets/{publicId}) for the
     * persisted SVG file. Absent when persistence was skipped or failed.
     */
    serveUrl: z.string().optional(),
    /**
     * Present when the SVG could not be persisted as a conversation file.
     * The inline result is still fully usable — this only means the file
     * will not appear in the Conversation Files panel.
     */
    persistWarning: z.string().optional(),
    /** Render directive instructing the chat UI to show the svg-preview component. */
    render: renderDirectiveSchema,
  }),
});

export type SvgGenerateInput = z.output<typeof svgGenerate.input>;
export type SvgGenerateOutput = z.output<typeof svgGenerate.output>;
