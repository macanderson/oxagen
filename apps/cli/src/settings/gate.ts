/**
 * gate.ts — Wraps the agent's local tools with the settings-driven permission
 * gate and PreToolUse/PostToolUse hooks.
 *
 * This is the single chokepoint where `settings.json` becomes load-bearing for
 * tool execution: every tool's `execute` is intercepted to (1) evaluate the
 * permission rules and (2) fire hooks. A denied call or a blocking PreToolUse
 * hook returns a plain string the model reads instead of running the tool — the
 * loop continues, the side effect never happens.
 */
import type { ToolSet } from "ai";
import { runHooks } from "./hooks.js";
import { evaluateLocalPermission } from "./permissions-gate.js";
import type { Hooks, Permissions } from "./schema.js";

export interface ToolGateContext {
  cwd: string;
  permissions?: Permissions;
  hooks?: Hooks;
  /** Aborts in-flight hook commands when the turn is cancelled. */
  signal?: AbortSignal;
  /** Notified whenever a tool call is blocked (for surfacing in the UI/logs). */
  onBlocked?: (toolName: string, reason: string) => void;
  /**
   * Map from a permission deny entry (e.g. `Edit(migrations/**)`) to a human
   * message. When a workspace rule's guard produces the deny, the agent sees the
   * rule text instead of the raw glob, so it self-corrects. (See the rules
   * module / adherence loop.)
   */
  denyReasons?: Record<string, string>;
}

type ToolExecute = NonNullable<ToolSet[string]["execute"]>;

/**
 * Return a copy of `tools` whose executes are gated. Tools without an `execute`
 * (none today, but the type allows it) pass through untouched.
 */
export function wrapToolsWithGate(
  tools: ToolSet,
  ctx: ToolGateContext,
): ToolSet {
  // Nothing to enforce → hand back the original set (zero overhead).
  if (!ctx.permissions && !ctx.hooks) return tools;

  const out: ToolSet = {};
  for (const [name, original] of Object.entries(tools)) {
    const exec = original.execute as ToolExecute | undefined;
    if (!exec) {
      out[name] = original;
      continue;
    }

    const gated: ToolExecute = async (input, options) => {
      const perm = evaluateLocalPermission(name, input, ctx.permissions);
      if (perm.decision === "deny") {
        const ruleMessage = perm.rule
          ? ctx.denyReasons?.[perm.rule]
          : undefined;
        const reason = ruleMessage
          ? `Blocked by ${ruleMessage}`
          : `Permission denied: \`${name}\` ${perm.reason}.`;
        ctx.onBlocked?.(name, ruleMessage ?? perm.reason);
        return `⛔ ${reason}`;
      }

      const pre = await runHooks(
        ctx.hooks,
        { event: "PreToolUse", cwd: ctx.cwd, tool: { name, input } },
        ctx.signal,
      );
      if (pre.blocked) {
        const reason = pre.reason ?? "blocked by PreToolUse hook";
        ctx.onBlocked?.(name, reason);
        return `⛔ Blocked by PreToolUse hook: ${reason}`;
      }

      // The AI SDK types a generic tool's output as `any`; narrow to `unknown`
      // so we handle it safely (and never re-leak `any` to callers).
      const result: unknown = await exec(input, options);

      // PostToolUse is observational — its exit code never blocks.
      await runHooks(
        ctx.hooks,
        {
          event: "PostToolUse",
          cwd: ctx.cwd,
          tool: { name, input },
          toolResult:
            typeof result === "string" ? result.slice(0, 2000) : undefined,
        },
        ctx.signal,
      );

      return result;
    };

    out[name] = { ...original, execute: gated };
  }
  return out;
}
