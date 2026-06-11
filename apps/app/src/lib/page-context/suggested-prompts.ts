"use client";
/**
 * suggested-prompts.ts — context-aware suggested prompt chips for the wand widget.
 *
 * The hook returns exactly 3 suggestions derived from the current screen context:
 *   - the registered page entity (kind + label)
 *   - the registered fillable form (title + fields)
 *   - the current pathname (route section: settings, billing, conversation, etc.)
 *
 * Design contract (stable — consumed by the chat agent's chip renderer):
 *   useSuggestedPrompts(): SuggestedPrompt[]    always length === 3
 *   SuggestedPrompt { label: string; prompt: string }
 *
 * The `label` is a short button label (~3–5 words, title-cased).
 * The `prompt` is the full text the agent receives when the chip is activated.
 *
 * Architecture note: all logic is extracted into `deriveSuggestions(ctx)` (a
 * pure function) so the hook is trivially testable without React. Only the hook
 * calls `usePageContext()` and `usePathname()`.
 */

import { usePathname } from "next/navigation";
import { usePageContext } from "./index";
import type { PageEntity, RegisteredFillableForm } from "./types";

// ---------------------------------------------------------------------------
// Public type — the stable return-type contract for the chat agent.
// ---------------------------------------------------------------------------

/**
 * A single suggested prompt chip.
 *
 * @property label  Short, title-cased button label displayed in the UI (≤5 words).
 * @property prompt Full prompt text sent to the agent when the chip is activated.
 */
export interface SuggestedPrompt {
  readonly label: string;
  readonly prompt: string;
}

// ---------------------------------------------------------------------------
// Derivation context (pure, no React dependency)
// ---------------------------------------------------------------------------

export interface SuggestionCtx {
  pathname: string;
  entity: PageEntity | null;
  fillableForm: RegisteredFillableForm | null;
}

// ---------------------------------------------------------------------------
// Route-section classifier (pure helper used by deriveSuggestions + tests)
// ---------------------------------------------------------------------------

type RouteSection =
  | "settings"
  | "billing"
  | "conversation"
  | "knowledge"
  | "automation"
  | "activity"
  | "studio"
  | "account"
  | "members"
  | "developer"
  | "default";

/**
 * Classify the current pathname into a broad section for suggestion targeting.
 * Pure function — no React, no side effects.
 */
export function classifyRoute(pathname: string): RouteSection {
  const p = pathname.toLowerCase();
  if (p.includes("/billing")) return "billing";
  if (p.includes("/settings")) return "settings";
  if (p.includes("/ask") || p.includes("/chat")) return "conversation";
  if (p.includes("/knowledge")) return "knowledge";
  if (p.includes("/automation")) return "automation";
  if (p.includes("/activity")) return "activity";
  if (p.includes("/studio")) return "studio";
  if (p.startsWith("/account")) return "account";
  if (p.includes("/members")) return "members";
  if (p.includes("/developer")) return "developer";
  return "default";
}

// ---------------------------------------------------------------------------
// Pure derivation function (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Derive exactly 3 contextual suggested prompts.
 *
 * Resolution strategy:
 *   1. If a fillable form is registered, one chip always targets form-fill.
 *   2. Remaining slots are filled from entity + route context.
 *   3. Fallback chips are provided when nothing is registered.
 *
 * Always returns exactly 3 items.
 */
export function deriveSuggestions(ctx: SuggestionCtx): SuggestedPrompt[] {
  const { pathname, entity, fillableForm } = ctx;
  const section = classifyRoute(pathname);

  const suggestions: SuggestedPrompt[] = [];

  // ── Slot 1: fill chip (when a form is registered) ─────────────────────────
  if (fillableForm) {
    suggestions.push({
      label: `Fill ${fillableForm.title}`,
      prompt: `Fill in the ${fillableForm.title} form for me based on the context and best practices.`,
    });
  }

  // ── Slot 2: entity-aware chip ─────────────────────────────────────────────
  if (entity) {
    const entityLabel = entity.label ?? entity.kind;
    switch (entity.kind) {
      case "workspace":
        suggestions.push({
          label: "Explain This Workspace",
          prompt: `Explain what the workspace "${entityLabel}" is set up for and what I can do here.`,
        });
        break;
      case "organization":
        suggestions.push({
          label: "Org Overview",
          prompt: `Give me an overview of the organization "${entityLabel}" — its workspaces, members, and billing status.`,
        });
        break;
      case "user":
      case "profile":
        suggestions.push({
          label: "Profile Suggestions",
          prompt: `Review my profile settings and suggest any improvements or missing information.`,
        });
        break;
      default:
        suggestions.push({
          label: `About This ${entity.kind}`,
          prompt: `Tell me about "${entityLabel}" (${entity.kind}) and what I can do with it.`,
        });
    }
  }

  // ── Slot 3 (and fill if needed): route-section chips ─────────────────────
  switch (section) {
    case "settings":
      suggestions.push({
        label: "Review My Settings",
        prompt: "Review the current settings on this page and suggest optimal values based on best practices.",
      });
      if (!fillableForm) {
        suggestions.push({
          label: "Explain These Settings",
          prompt: "Explain what each setting on this page does and how it affects my workspace.",
        });
      }
      break;

    case "billing":
      suggestions.push({
        label: "Summarize Usage",
        prompt: "Summarize my current usage and costs. Flag any unusual spend or optimization opportunities.",
      });
      suggestions.push({
        label: "Explain My Plan",
        prompt: "Explain my current billing plan, what is included, and whether I should consider upgrading or downgrading.",
      });
      break;

    case "conversation":
      suggestions.push({
        label: "Continue Last Thread",
        prompt: "Pick up where we left off in this conversation and continue the work.",
      });
      suggestions.push({
        label: "Summarize Conversation",
        prompt: "Summarize this conversation so far, highlighting key decisions, action items, and open questions.",
      });
      break;

    case "knowledge":
      suggestions.push({
        label: "Explore Knowledge",
        prompt: "What knowledge sources are connected to this workspace? Show me the most recently updated ones.",
      });
      suggestions.push({
        label: "Find Gaps",
        prompt: "Identify any gaps or stale information in this workspace's knowledge base.",
      });
      break;

    case "automation":
      suggestions.push({
        label: "Review Automations",
        prompt: "Review the automations configured in this workspace and flag any that are inactive or could be optimized.",
      });
      suggestions.push({
        label: "Suggest Automations",
        prompt: "Based on this workspace's knowledge and integrations, suggest useful automations I could set up.",
      });
      break;

    case "activity":
      suggestions.push({
        label: "Recent Activity",
        prompt: "Summarize recent agent activity in this workspace — what ran, what succeeded, what failed.",
      });
      suggestions.push({
        label: "Failed Runs",
        prompt: "Show me any failed automation runs and help me understand why they failed.",
      });
      break;

    case "studio":
      suggestions.push({
        label: "Create a Tool",
        prompt: "Help me compose a new tool in Studio. What kind of tool would be most useful for this workspace?",
      });
      suggestions.push({
        label: "Review My Tools",
        prompt: "Review the tools in my library and identify any that are redundant, outdated, or need updating.",
      });
      break;

    case "account":
      suggestions.push({
        label: "Optimize Preferences",
        prompt: "Review my account preferences and suggest optimal settings for a productive experience.",
      });
      suggestions.push({
        label: "Security Check",
        prompt: "Review my account security settings and flag any risks or best-practice gaps.",
      });
      break;

    case "members":
      suggestions.push({
        label: "Review Access",
        prompt: "Review the members list and flag any unusual permission assignments or inactive accounts.",
      });
      suggestions.push({
        label: "Invite Guide",
        prompt: "Walk me through inviting a new team member with the correct permissions for their role.",
      });
      break;

    case "developer":
      suggestions.push({
        label: "MCP Setup Guide",
        prompt: "Walk me through connecting to the Oxagen MCP server from my local development environment.",
      });
      suggestions.push({
        label: "API Key Review",
        prompt: "Review my API tokens and webhooks. Flag any that are unused, expired, or overly permissive.",
      });
      break;

    default:
      // Workspace overview fallback
      suggestions.push({
        label: "What Can I Do Here?",
        prompt: "I'm on the Oxagen dashboard. What can I do from here? Give me a quick orientation.",
      });
      suggestions.push({
        label: "Recent Changes",
        prompt: "What's changed in this workspace recently? Show me recent activity and updates.",
      });
      break;
  }

  // ── Guarantee exactly 3 ────────────────────────────────────────────────────
  // Trim if somehow we have too many (defensive).
  while (suggestions.length > 3) {
    suggestions.pop();
  }

  // Pad to 3 with generic fallbacks if we somehow have fewer.
  const fallbacks: SuggestedPrompt[] = [
    {
      label: "What Can I Do Here?",
      prompt: "I'm on the Oxagen dashboard. What can I do from here? Give me a quick orientation.",
    },
    {
      label: "Recent Activity",
      prompt: "What has happened in this workspace recently? Summarize any notable activity.",
    },
    {
      label: "Help Me Optimize",
      prompt: "Review my current configuration and suggest ways to optimize my setup.",
    },
  ];

  let fi = 0;
  while (suggestions.length < 3 && fi < fallbacks.length) {
    const fb = fallbacks[fi++];
    // Avoid exact duplicates by prompt text.
    if (fb && !suggestions.some((s) => s.prompt === fb.prompt)) {
      suggestions.push(fb);
    }
  }

  return suggestions.slice(0, 3);
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Returns exactly 3 context-aware suggested prompts for the current screen.
 *
 * Consumes `PageContext` (entity + fillableForm) and `usePathname()`.
 * Must be called inside a `PageContextProvider` and a Next.js route.
 *
 * @returns Array of exactly 3 `SuggestedPrompt` items.
 *
 * @example
 * const prompts = useSuggestedPrompts();
 * prompts.forEach(({ label, prompt }) => <Button onClick={() => send(prompt)}>{label}</Button>)
 */
export function useSuggestedPrompts(): SuggestedPrompt[] {
  const { entity, fillableForm } = usePageContext();
  const pathname = usePathname();
  return deriveSuggestions({ pathname, entity, fillableForm });
}
