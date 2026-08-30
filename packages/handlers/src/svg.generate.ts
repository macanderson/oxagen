import { z } from "zod";
import {
  generateObjectFor,
  resolvePrompt,
  svgGeneratePrompt,
  loadWorkspacePromptConfigSafe,
  enhancePromptIfInsufficient,
  defaultModel,
  modelIdOf,
} from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { svgGenerate } from "@oxagen/oxagen/contracts/svg.generate";
import { logger } from "./logger";
import { persistGeneratedAsset } from "./generated-asset.persist";

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
  out = out.replace(
    /(href|xlink:href)\s*=\s*["']?\s*javascript:[^"'\s>]*/gi,
    "",
  );
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
    .describe(
      "A concise, human-readable title for the graphic (5–60 characters).",
    ),
});

// ── Handler ───────────────────────────────────────────────────────────────────

export const svgGenerateHandler: CapabilityHandler<typeof svgGenerate> = async (
  input,
  ctx,
) => {
  const width = input.width ?? 400;
  const height = input.height ?? 400;
  const messageId = ctx.messageId ?? ctx.requestId;

  // Resolve the system prompt through the registry so an enterprise workspace
  // can override the svg.generate baseline (it's a curated-overridable key) and
  // any workspace's "additional instructions" are appended. Best-effort load —
  // a missing config yields the untouched baseline.
  const promptConfig = await loadWorkspacePromptConfigSafe(ctx.workspaceId);

  // Auto-improve (Beta): when the workspace toggle is on (default), let the LLM
  // judge enhance an insufficient description before generation.
  const { prompt: effectivePrompt } = await enhancePromptIfInsufficient({
    prompt: input.prompt,
    kind: "svg",
    autoImprove: promptConfig.autoImprovePrompts ?? true,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      messageId,
    },
  });

  let rawSvg: string;
  let title: string;
  let generationFailed = false;

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
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        prompt: input.prompt,
      },
      "svg.generate: model error — returning placeholder SVG",
    );
    rawSvg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" fill="none" stroke="currentColor" stroke-width="2" rx="8"/><text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="currentColor" font-size="14">SVG generation failed</text></svg>`;
    title = input.title ?? "Generation failed";
    generationFailed = true;
  }

  const svg = sanitizeSvg(rawSvg);

  // ── Persist as a conversation file ────────────────────────────────────────
  // Every generated artifact must land in the Conversation Files panel, so the
  // sanitized SVG is uploaded to blob storage + a generated_assets row via the
  // shared persistGeneratedAsset seam (conversation linkage resolves from
  // ctx.messageId inside the seam). Persistence is strictly non-fatal: the
  // inline render directive below is always returned, and any failure only
  // surfaces as `persistWarning` in the output. The failure-placeholder SVG is
  // never persisted — a "generation failed" graphic is not a user file.
  let assetPublicId: string | undefined;
  let serveUrl: string | undefined;
  let persistWarning: string | undefined;

  if (!generationFailed) {
    if (!ctx.userId) {
      persistWarning =
        "SVG was not saved to conversation files: no user identity in the request context.";
    } else {
      try {
        const asset = await persistGeneratedAsset({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          kind: "image",
          accessPolicy: "org",
          bytes: new TextEncoder().encode(svg),
          mimeType: "image/svg+xml",
          prompt: input.prompt,
          model: modelIdOf(defaultModel()),
          displayName: title,
          messageId: ctx.messageId ?? undefined,
        });
        assetPublicId = asset.publicId;
        serveUrl = asset.serveUrl;
      } catch (err) {
        logger.warn(
          { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, title },
          "svg.generate: asset persistence failed (non-fatal) — returning inline result only",
        );
        persistWarning =
          "SVG was generated but could not be saved to conversation files.";
      }
    }
  }

  return {
    svg,
    title,
    ...(assetPublicId !== undefined ? { assetPublicId } : {}),
    ...(serveUrl !== undefined ? { serveUrl } : {}),
    ...(persistWarning !== undefined ? { persistWarning } : {}),
    render: {
      componentId: "svg-preview",
      props: {
        svg,
        title,
        ...(serveUrl !== undefined ? { serveUrl } : {}),
        ...(assetPublicId !== undefined ? { assetPublicId } : {}),
      },
    },
  };
};
