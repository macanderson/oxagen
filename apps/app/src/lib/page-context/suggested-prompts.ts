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
// Conversation message summary (minimal — only what suggestion logic needs)
// ---------------------------------------------------------------------------

/**
 * A minimal summary of a conversation message used for context-aware suggestion
 * generation. Only role and the first 300 chars of content are needed.
 */
export interface ConversationMessageSummary {
  role: "user" | "assistant";
  /** First 300 chars of the message text (truncated for perf). */
  content: string;
}

// ---------------------------------------------------------------------------
// Derivation context (pure, no React dependency)
// ---------------------------------------------------------------------------

export interface SuggestionCtx {
  pathname: string;
  entity: PageEntity | null;
  fillableForm: RegisteredFillableForm | null;
  /**
   * Recent conversation messages (last ≤6) for context-aware suggestions.
   * When provided and non-empty the suggestions shift from page-context
   * defaults to conversation-continuation prompts.
   */
  conversationHistory?: ConversationMessageSummary[];
}

// ---------------------------------------------------------------------------
// Route-section classifier (pure helper used by deriveSuggestions + tests)
// ---------------------------------------------------------------------------

type RouteSection =
  | "settings"
  | "billing"
  | "conversation"
  | "knowledge"
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
  if (p.startsWith("/account")) return "account";
  if (p.includes("/members")) return "members";
  if (p.includes("/developer")) return "developer";
  return "default";
}

// ---------------------------------------------------------------------------
// Pure derivation function (exported for tests)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Conversation-history analysis helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Extract the last assistant message text from conversation history.
 * Returns null when history is empty or has no assistant turn.
 */
export function lastAssistantText(
  history: ConversationMessageSummary[],
): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg && msg.role === "assistant" && msg.content.trim().length > 0) {
      return msg.content.trim();
    }
  }
  return null;
}

/**
 * Build-oriented suggestion bank for conversation mode (the no-LLM fallback).
 *
 * Every entry pushes the user toward CREATING something real in Oxagen — an
 * agent, an automation, a connector, a graph query, an eval suite, a billing
 * meter, an MCP tool, an API route — rather than passively summarizing the
 * thread. The per-turn LLM path (stream "suggested-prompts" event) is the
 * primary, conversation-specific source; this bank is what shows on an empty
 * state, a page reload, or when generation fails.
 */
const BUILD_SUGGESTION_BANK: readonly SuggestedPrompt[] = [
  {
    label: "Turn Into An Agent",
    prompt:
      "Create a reusable Oxagen agent that does what we just worked through, and equip it with the tools and skills it needs.",
  },
  {
    label: "Automate This",
    prompt:
      "Design an automation or workflow that runs this for me end to end on a schedule or trigger.",
  },
  {
    label: "Add To Knowledge Graph",
    prompt:
      "Wire the key facts from our conversation into the workspace knowledge graph so future agents can cite them.",
  },
  {
    label: "Expose As MCP Tool",
    prompt:
      "Turn this into an MCP tool I can call from my other agents and IDE — define the contract, inputs, and output.",
  },
  {
    label: "Set Up An Eval",
    prompt:
      "Create an eval suite that checks the quality of what we just produced, with a few concrete test cases.",
  },
  {
    label: "Meter And Bill It",
    prompt:
      "Set up a usage meter for this so I can track consumption and bill customers for it.",
  },
  {
    label: "Connect A Data Source",
    prompt:
      "Recommend and connect a data source that would make this better, and map it into the knowledge graph.",
  },
  {
    label: "Query The Graph",
    prompt:
      "Explore the knowledge graph for entities and relationships related to what we just discussed.",
  },
  {
    label: "Draft A Skill",
    prompt:
      "Package the approach we just took into a reusable agent skill I can share with my team.",
  },
  {
    label: "Publish To Marketplace",
    prompt:
      "Help me package and publish what we built as a listing in the Oxagen marketplace.",
  },
  {
    label: "Wire Up An API Route",
    prompt:
      "Expose this capability as a REST API endpoint I can call from my app, with the request and response shape.",
  },
  {
    label: "Scale With A Fleet",
    prompt:
      "Show me how to run this across many inputs at once using a fleet of subagents, then aggregate the results.",
  },
];

/**
 * Deterministic, non-cryptographic string hash (djb2). Used only to derive a
 * stable rotation seed from conversation content — never for security. Pure so
 * the same conversation always yields the same trio (testable, no Math.random).
 */
export function hashString(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    // h * 33 + charCode, kept in the 32-bit unsigned range.
    h = (((h << 5) + h) + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Pick `count` distinct items from `bank` starting at `seed`, stepping by one
 * and wrapping — a deterministic rotation so a changing seed surfaces a
 * different (but stable-per-seed) window of the bank.
 */
function pickRotating<T>(bank: readonly T[], seed: number, count: number): T[] {
  const n = bank.length;
  if (n === 0) return [];
  const start = ((seed % n) + n) % n;
  const out: T[] = [];
  for (let i = 0; i < count && i < n; i++) {
    out.push(bank[(start + i) % n]!);
  }
  return out;
}

/**
 * Derive build-oriented conversation suggestions from the last few turns.
 *
 * Returns exactly 3 prompts (given a non-empty bank) that push the user toward
 * building something in Oxagen. Selection ROTATES deterministically per turn:
 * the seed combines the history length (which grows every turn) with a hash of
 * the latest assistant reply, so each turn surfaces a different trio while the
 * SAME conversation state always yields the same trio (deterministic, testable).
 */
export function deriveConversationSuggestions(
  history: ConversationMessageSummary[],
): SuggestedPrompt[] {
  if (history.length === 0) return [];
  const lastAssistant = lastAssistantText(history) ?? "";
  const seed = history.length + hashString(lastAssistant.slice(0, 200));
  return pickRotating(BUILD_SUGGESTION_BANK, seed, 3);
}

/**
 * Derive exactly 3 contextual suggested prompts.
 *
 * Resolution strategy:
 *   1. When conversation history is present (multi-turn), derive continuation
 *      suggestions from the last assistant reply — these are more relevant than
 *      page-context defaults mid-conversation.
 *   2. If a fillable form is registered, one chip always targets form-fill.
 *   3. Remaining slots are filled from entity + route context.
 *   4. Fallback chips are provided when nothing is registered.
 *
 * Always returns exactly 3 items.
 */
export function deriveSuggestions(ctx: SuggestionCtx): SuggestedPrompt[] {
  const { pathname, entity, fillableForm, conversationHistory } = ctx;
  const section = classifyRoute(pathname);

  // ── Conversation-continuation mode (multi-turn) ───────────────────────────
  // When there are messages in the conversation, derive continuation suggestions
  // from the conversation history instead of the page-context defaults.
  // A fillable form chip is still prepended if registered, since form-fill is
  // always actionable regardless of conversation state.
  if (conversationHistory && conversationHistory.length > 0) {
    const convSuggestions = deriveConversationSuggestions(conversationHistory);
    if (convSuggestions.length === 3) {
      if (fillableForm) {
        // Replace the last chip with the form-fill chip so form-fill stays accessible.
        return [
          {
            label: `Fill ${fillableForm.title}`,
            prompt: `Fill in the ${fillableForm.title} form for me based on the context and best practices.`,
          },
          convSuggestions[0]!,
          convSuggestions[1]!,
        ];
      }
      return convSuggestions;
    }
  }

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
        prompt: "What integrations are connected to this workspace? Show me the most recently updated ones.",
      });
      suggestions.push({
        label: "Find Gaps",
        prompt: "Identify any gaps or stale information in this workspace's knowledge base.",
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
 * @param conversationHistory  Optional recent conversation messages. When
 *   provided and non-empty, suggestions are derived from the conversation
 *   context rather than page defaults — keeping them relevant as the
 *   conversation evolves across multiple turns.
 *
 * @returns Array of exactly 3 `SuggestedPrompt` items.
 *
 * @example
 * const prompts = useSuggestedPrompts(history);
 * prompts.forEach(({ label, prompt }) => <Button onClick={() => send(prompt)}>{label}</Button>)
 */
export function useSuggestedPrompts(
  conversationHistory?: ConversationMessageSummary[],
): SuggestedPrompt[] {
  const { entity, fillableForm } = usePageContext();
  const pathname = usePathname();
  return deriveSuggestions({ pathname, entity, fillableForm, conversationHistory });
}
