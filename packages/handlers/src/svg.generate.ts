import { z } from "zod";
import {
  generateObjectFor,
  resolvePrompt,
  svgGeneratePrompt,
  loadWorkspacePromptConfigSafe,
  enhancePromptIfInsufficient,
} from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { svgGenerate } from "@oxagen/oxagen/contracts/svg.generate";
import { logger } from "./logger";

// ── SVG sanitisation ──────────────────────────────────────────────────────────
// Strip <script> blocks and inline event-handler attributes before the markup
// leaves this process. The chat component does NOT use dangerouslySetInnerHTML
// — it renders via an <img src="data:image/svg+xml,..."> — so this is a
// defence-in-depth measure rather than the sole XSS guard.

function sanitizeSvg(raw: string): string {
  // Remove <script ...>...</script> blocks (case-insensitive, multiline).
  let out = raw.replace(/<script[\s\S]*?<\/script>/gi, "");
  // Remove standalone <script ... /> self-closing tags.
  out = out.replace(/<script[^>]*\/>/gi, "");
  // Remove on* event handler attributes (onclick, onload, onerror, etc.)
  // The regex matches the attribute name with optional whitespace around =.
  out = out.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");
  // Remove javascript: href/xlink:href values.
  out = out.replace(/(href|xlink:href)\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, "");
  return out.trim();
}

// ── Model schema ──────────────────────────────────────────────────────────────

const svgModelSchema = z.object({
  svg: z
    .string()
    .min(1)
    .describe(
      "Complete, valid SVG markup. Must open with <svg and close with </svg>. " +
        "Use currentColor for strokes/fills so the graphic adapts to light and dark mode. " +
        "Use CSS custom properties (--color-primary etc.) for brand colours. " +
        "Animations via <animate> or CSS @keyframes inside a <style> block are encouraged. " +
        "Do NOT include <script> tags or on* event handlers.",
    ),
  title: z
    .string()
    .min(1)
    .describe("A concise, human-readable title for the graphic (5–60 characters)."),
});

// ── Handler ───────────────────────────────────────────────────────────────────

export const svgGenerateHandler: CapabilityHandler<typeof svgGenerate> = async (input, ctx) => {
  const width = input.width ?? 400;
  const height = input.height ?? 400;
  const messageId = ctx.messageId ?? ctx.requestId;

  // Resolve the system prompt through the registry so an enterprise workspace
  // can override the svg.generate baseline (it's a curated-overridable key) and
  // any workspace's "additional instructions" are appended. Best-effort load —
  // a missing config simply yields the untouched baseline.
  const promptConfig = await loadWorkspacePromptConfigSafe(ctx.workspaceId);

  // Auto-improve (Beta): when the workspace toggle is on (default), let the LLM
  // judge enhance an insufficient description before generation.
  const { prompt: effectivePrompt } = await enhancePromptIfInsufficient({
    prompt: input.prompt,
    kind: "svg",
    autoImprove: promptConfig.autoImprovePrompts ?? true,
    telemetry: { orgId: ctx.orgId, workspaceId: ctx.workspaceId, surface: ctx.surface, messageId },
  });

  let rawSvg: string;
  let title: string;

  try {
    const result = await generateObjectFor({
      schema: svgModelSchema,
      system: resolvePrompt({
        key: "svg.generate",
        baseline: svgGeneratePrompt(width, height),
        config: promptConfig,
      }),
      prompt: [
        input.title ? `Title: ${input.title}` : "",
        `Description: ${effectivePrompt}`,
      ]
        .filter(Boolean)
        .join("\n"),
      temperature: 0.7,
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        messageId,
      },
    });
    rawSvg = result.object.svg;
    title = result.object.title;
  } catch (err) {
    // Never throw — return a minimal placeholder SVG so the render path always works.
    logger.warn(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, prompt: input.prompt },
      "svg.generate: model error — returning placeholder SVG",
    );
    rawSvg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="none" stroke="currentColor" stroke-width="2" rx="8"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="currentColor" font-size="14">SVG generation failed</text></svg>`;
    title = input.title ?? "Generation failed";
  }

  const svg = sanitizeSvg(rawSvg);

  return {
    svg,
    title,
    render: {
      componentId: "svg-preview",
      props: { svg, title },
    },
  };
};
