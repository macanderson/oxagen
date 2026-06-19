import { z } from "zod";
import { registerCapability } from "../registry";

// ── Render directive schema (mirrors RenderDirective in stream-event-types) ───

const renderDirectiveSchema = z.object({
  componentId: z.string(),
  props: z.record(z.unknown()),
});

// ── Contract registration ─────────────────────────────────────────────────────

export const mermaidGenerate = registerCapability({
  name: "mermaid.generate",
  domain: "mermaid",
  description:
    "Produce a Mermaid diagram from validated diagram source text. " +
    "The source is validated (non-empty, within length cap) and returned with a " +
    "render directive so the chat UI renders it inline as an SVG via the " +
    "'mermaid-diagram' client component — no server-side rendering involved. " +
    "Supports flowcharts, sequence diagrams, class diagrams, Gantt charts, and all " +
    "other diagram types supported by Mermaid v11.",
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
    /** Human-readable title for the diagram — shown in the card heading. */
    title: z.string().min(1).max(200),
    /**
     * Mermaid diagram source text. Must be non-empty and within the 50,000-character
     * cap. The handler does not interpret the content — it is passed to the client
     * component which renders it in the browser via the Mermaid library.
     */
    diagram: z.string().min(1).max(50_000),
    /**
     * Optional Mermaid theme. Defaults to 'default'.
     * 'dark' and 'neutral' / 'forest' are also well-supported.
     */
    theme: z.enum(["default", "dark", "neutral", "forest"]).optional(),
  }),
  output: z.object({
    /** Human-readable title passed through from input. */
    title: z.string().min(1),
    /** Validated Mermaid diagram source text ready for client rendering. */
    source: z.string().min(1),
    /** Render directive instructing the chat UI to show the mermaid-diagram component. */
    render: renderDirectiveSchema,
  }),
});

export type MermaidGenerateInput = z.output<typeof mermaidGenerate.input>;
export type MermaidGenerateOutput = z.output<typeof mermaidGenerate.output>;
