import { z } from "zod";
import { registerCapability } from "../registry";

// ── Render directive schema (mirrors RenderDirective in stream-event-types) ───

const renderDirectiveSchema = z.object({
  componentId: z.string(),
  props: z.record(z.unknown()),
});

// ── Contract registration ─────────────────────────────────────────────────────

export const svgGenerate = registerCapability({
  name: "svg.generate",
  domain: "svg",
  description:
    "Generate clean, sanitized, inline SVG markup from a natural-language prompt. " +
    "The SVG uses currentColor and CSS custom properties so it adapts to light and dark mode. " +
    "Script tags and inline event handlers are stripped before the output is returned. " +
    "Returns the SVG markup, a title, and a render directive so the output renders inline in chat.",
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
    /** Sanitized inline SVG markup string ready for dangerouslySetInnerHTML. */
    svg: z.string().min(1),
    /** Human-readable title for the graphic. */
    title: z.string().min(1),
    /** Render directive instructing the chat UI to show the svg-preview component. */
    render: renderDirectiveSchema,
  }),
});

export type SvgGenerateInput = z.output<typeof svgGenerate.input>;
export type SvgGenerateOutput = z.output<typeof svgGenerate.output>;
