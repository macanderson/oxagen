/**
 * schema.ts — The unified `settings.json` schema that drives the Oxagen CLI.
 *
 * This is the CLI harness spine: a single file format, resolved across three
 * scopes (see resolve.ts), that configures the CLI's behavior the way Claude
 * Code's `settings.json` does. Sections:
 *
 *   - model          default gateway model slug for the agent loop
 *   - apiUrl         Oxagen platform API base URL
 *   - env            environment variables made available to the session
 *   - permissions    allow/deny rules + default mode for the agent's local tools
 *   - hooks          shell commands fired on lifecycle events (SessionStart /
 *                    PreToolUse / PostToolUse) — PreToolUse can block a tool
 *   - mcpServers     external MCP server definitions (reused from @oxagen/mcp-config)
 *   - toolVisibility per-MCP-server tool include/exclude (reused from @oxagen/mcp-config)
 *
 * Credentials (token / org / workspace / gatewayKey) intentionally do NOT live
 * here — they stay in the user-only `config.json` credential store so a project
 * `settings.json` is safe to commit. This mirrors Claude Code, which keeps
 * `.credentials.json` separate from `settings.json`.
 *
 * The MCP sections deliberately reuse the schemas from `@oxagen/mcp-config` so a
 * single `settings.json` validates identically here and in the platform agent
 * runtime that already reads MCP servers from the same file — no second source
 * of truth, no drift.
 */
import { z } from "zod";
import {
  mcpServerSchema,
  serverPermissionSchema,
  toolVisibilitySchema,
} from "@oxagen/mcp-config/schema";

// ── Permissions ───────────────────────────────────────────────────────────────

/**
 * Permission mode when no explicit allow/deny rule matches a tool call.
 *
 *   - "default" / "acceptEdits" → allow unless a deny rule matches
 *   - "deny"                    → block unless an allow rule matches (deny-by-default)
 *   - "bypassPermissions"       → allow everything (deny rules still take priority)
 *
 * Enforced for the agent's local tools in gate.ts. (Interactive "ask"/"plan"
 * prompting lands with the MCP-client PR; only the modes enforced today are
 * accepted here so the schema never advertises behavior that does not exist.)
 */
export const permissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "deny",
  "bypassPermissions",
]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/**
 * Permission rules for the agent's local tools, in Claude Code's rule syntax:
 *
 *   "Bash"              → the whole bash tool
 *   "Bash(git*)"        → bash commands matching the glob `git*`
 *   "Write"             → any file write
 *   "Write(src/**)"     → writes whose path matches `src/**`
 *   "Read(.env*)"       → reads whose path matches `.env*`
 *   "mcp__github__*"    → (reserved for the MCP gate) any tool on the `github` server
 *
 * `deny` always wins over `allow` at the same scope. The MCP-specific
 * `defaultMcpPolicy` / `mcpServers` fields are carried through unchanged so the
 * same `permissions` object also feeds @oxagen/mcp-config's per-server gate when
 * the MCP client lands.
 */
export const permissionsSchema = z.object({
  /** Mode applied when no allow/deny rule matches. Default: "default". */
  defaultMode: permissionModeSchema.optional(),
  /** Rules that explicitly permit a tool call (escape hatch from deny mode). */
  allow: z.array(z.string()).optional(),
  /** Rules that explicitly block a tool call. Highest priority. */
  deny: z.array(z.string()).optional(),
  // ── MCP compatibility (consumed by @oxagen/mcp-config, not by gate.ts) ──
  /** Global default policy for MCP tool invocations. */
  defaultMcpPolicy: z.enum(["allow", "deny", "ask"]).optional(),
  /** Per-MCP-server permission overrides, keyed by server name. */
  mcpServers: z.record(serverPermissionSchema).optional(),
});
export type Permissions = z.infer<typeof permissionsSchema>;

// ── Hooks ─────────────────────────────────────────────────────────────────────

/** Lifecycle events a hook can fire on. */
export const HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** A single shell command a hook runs. */
export const hookActionSchema = z.object({
  /** Only "command" hooks are supported. */
  type: z.literal("command").default("command"),
  /** Shell command. Receives the event payload as JSON on stdin. */
  command: z.string().min(1),
  /** Per-hook timeout in milliseconds (default 60000, max 600000). */
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});
export type HookAction = z.infer<typeof hookActionSchema>;

/**
 * A matcher groups hook actions under a tool-name pattern. For PreToolUse /
 * PostToolUse, `matcher` is a glob over the tool name (e.g. "bash",
 * "write_file", "*"). For SessionStart it is ignored (all actions run).
 */
export const hookMatcherSchema = z.object({
  /** Glob over the tool name. Omit (or "*") to match every tool. */
  matcher: z.string().optional(),
  /** Actions to run when this matcher matches. */
  hooks: z.array(hookActionSchema).min(1),
});
export type HookMatcher = z.infer<typeof hookMatcherSchema>;

/** Hooks keyed by lifecycle event. */
export const hooksSchema = z.object({
  SessionStart: z.array(hookMatcherSchema).optional(),
  PreToolUse: z.array(hookMatcherSchema).optional(),
  PostToolUse: z.array(hookMatcherSchema).optional(),
});
export type Hooks = z.infer<typeof hooksSchema>;

// ── Inline agent definitions ──────────────────────────────────────────────────

/**
 * A named agent declared inline in settings.json (an alternative to a markdown
 * file under `.oxagen/agents/`). `prompt` is the system prompt; `tools` is the
 * permission-syntax allowlist (omit to inherit every tool).
 */
export const inlineAgentSchema = z.object({
  description: z.string().optional(),
  prompt: z.string().min(1),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** Skill names to pre-load for this agent (matched against `loadSkills`). */
  skills: z.array(z.string()).optional(),
  /** Keys into the top-level `mcpServers` map this agent connects to. */
  mcpServers: z.array(z.string()).optional(),
});
export type InlineAgent = z.infer<typeof inlineAgentSchema>;

// ── Top-level settings ────────────────────────────────────────────────────────

export const oxagenSettingsSchema = z
  .object({
    /** Optional JSON-Schema reference for editor autocompletion. */
    $schema: z.string().optional(),
    /**
     * Default gateway model slug for the agent loop (e.g. "anthropic/claude-sonnet-5").
     * Acts as the universal fallback for every pipeline role: any role whose own
     * key below is unset inherits this value (which itself falls back to the
     * built-in tier default). Set the per-role keys to run each stage on a
     * different model without touching the others.
     */
    model: z.string().optional(),
    /**
     * Model for the WORKER role — the executor that runs the tool loop and edits
     * code. Falls back to `model`. Set via `/worker-model`.
     */
    workerModel: z.string().optional(),
    /**
     * Model for the JUDGE role — the completeness advisor / judge panel that
     * grades a turn's output. Falls back to a distinct advisor tier derived from
     * the worker. Set via `/judge-model`.
     */
    judgeModel: z.string().optional(),
    /**
     * Model for the TRIAGE / coordinator role — the planner that decomposes the
     * goal AND the pre-execution evaluator/classifier. Falls back to `model`
     * (planner) and the local heuristic (evaluator). Set via `/triage-model`.
     */
    triageModel: z.string().optional(),
    /**
     * Reasoning effort for models that support it. Forwarded to the model as
     * `reasoning_effort`; ignored by models without a reasoning mode. Higher
     * effort = deeper thinking, more tokens, higher cost.
     */
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    /** Oxagen platform API base URL (overrides config.json; env still wins). */
    apiUrl: z.string().url().optional(),
    /** Environment variables exported into the session (fills only unset vars; shell wins). */
    env: z.record(z.string()).optional(),
    /** Allow/deny rules + default mode for the agent's local tools. */
    permissions: permissionsSchema.optional(),
    /** Shell commands fired on lifecycle events. */
    hooks: hooksSchema.optional(),
    /** External MCP server definitions, keyed by name. */
    mcpServers: z.record(mcpServerSchema).optional(),
    /** Per-MCP-server tool visibility, keyed by server name. */
    toolVisibility: z.record(toolVisibilitySchema).optional(),
    /** Inline named agent definitions, keyed by agent name. */
    agents: z.record(inlineAgentSchema).optional(),
    /**
     * When true, the interactive REPL pauses before executing each turn to show
     * the enhanced prompt and an estimated cost, letting you edit the prompt or
     * cancel before any work runs. Default false (turns run immediately).
     */
    confirmScope: z.boolean().optional(),
    /**
     * When true, the interactive REPL runs "task"-classified prompts as detached
     * background fleet dispatches (the composer frees immediately) instead of
     * inline turns; conversational lookups still answer inline. Toggle live with
     * `/dispatch`. Default false. See docs/specs/repl-async-dispatch.md.
     */
    dispatchMode: z.boolean().optional(),
    /**
     * Max concurrent background dispatches the REPL runs before queueing further
     * ones locally (never spawning unbounded workers). Default 4. Set with
     * `/dispatch cap <n>`.
     */
    dispatchMaxConcurrent: z.number().int().positive().optional(),
  })
  // Forward-compatible: sections that land in later PRs (agents, commands,
  // skills) may already be present in a user's file; pass them through rather
  // than failing validation, so the file format is stable across the rollout.
  .passthrough();

export type OxagenSettings = z.infer<typeof oxagenSettingsSchema>;
