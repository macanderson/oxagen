import { TuiFrame } from "./tui-frame";
import { tuiColors, tuiGlyphs } from "./tui-theme";

/**
 * TuiInteractiveAnswer — a REPL turn mid-flight: the user's prompt, the
 * agent's streaming answer, two tool-call chips, the `/hud` heads-up display
 * (apps/cli/src/repl/hud.tsx) showing the running agent team, and the busy
 * prompt bar underneath. Colors match `getToolAccent`/`getToolEmoji`
 * (apps/cli/src/agent/tool-formatter.ts) and `activityGlyph`
 * (apps/cli/src/tui/activity.ts) exactly: cyan = read, green = write, cyan
 * dot = running, green check = done.
 */
export function TuiInteractiveAnswer({ className }: { className?: string }) {
  return (
    <TuiFrame
      id="tui-answer"
      title="~/acme-web — oxagen"
      width={560}
      height={306}
      className={className}
    >
      <text x={20} y={48} fontSize={13}>
        <tspan fill={tuiColors.cyan} fontWeight={700}>
          {tuiGlyphs.pointer}{" "}
        </tspan>
        <tspan fill="#f5f5f5" fontWeight={700}>
          refactor the date helpers into a single module
        </tspan>
      </text>

      <text x={20} y={70} fontSize={12.5}>
        <tspan fill={tuiColors.violet} fontWeight={700}>
          {"◆ "}
        </tspan>
        <tspan fill="#e6e6e6">
          I&apos;ll consolidate date parsing and formatting
        </tspan>
      </text>
      <text x={32} y={88} fontSize={12.5}>
        <tspan fill="#e6e6e6">
          into src/lib/dates.ts, then update call sites
        </tspan>
        <tspan className="tui-caret" fill={tuiColors.cyan}>
          {" ▊"}
        </tspan>
      </text>

      {/* Tool chips — amber ⚡ bolt, accent-colored bracket per getToolAccent. */}
      <text x={20} y={110} fontSize={12}>
        <tspan fill={tuiColors.amber} fontWeight={700}>
          {"⚡ "}
        </tspan>
        <tspan fill={tuiColors.cyan}>[📖 Read]</tspan>
        <tspan fill={tuiColors.dim}>{"  src/lib/date-utils.ts"}</tspan>
      </text>
      <text x={20} y={130} fontSize={12}>
        <tspan fill={tuiColors.amber} fontWeight={700}>
          {"⚡ "}
        </tspan>
        <tspan fill={tuiColors.green}>[📝 Edit]</tspan>
        <tspan fill={tuiColors.dim}>{"  src/lib/dates.ts"}</tspan>
      </text>

      {/* /hud panel */}
      <rect
        x={20}
        y={148}
        width={520}
        height={80}
        rx={8}
        fill="none"
        stroke="rgba(255,255,255,0.14)"
      />
      <text x={32} y={166} fontSize={12}>
        <tspan className="tui-pulse" fill={tuiColors.cyan} fontWeight={700}>
          {tuiGlyphs.ring}{" "}
        </tspan>
        <tspan fill={tuiColors.violet} fontWeight={700}>
          HUD
        </tspan>
        <tspan fill={tuiColors.dim}>{"  ·  "}</tspan>
        <tspan fill={tuiColors.cyan}>1 running</tspan>
        <tspan fill={tuiColors.dim}>{"  ·  "}</tspan>
        <tspan fill={tuiColors.green}>{"✓ 1"}</tspan>
        <tspan fill={tuiColors.dim}>{"  ·  Esc to close"}</tspan>
      </text>
      <text x={32} y={188} fontSize={11.5}>
        <tspan fill={tuiColors.cyan} fontWeight={700}>
          {"● "}
        </tspan>
        <tspan fill={tuiColors.dim}>[turn] </tspan>
        <tspan fill="#e6e6e6">
          refactor the date helpers into a single module
        </tspan>
      </text>
      <text x={44} y={204} fontSize={11}>
        <tspan fill={tuiColors.dim}>38s · </tspan>
        <tspan fill={tuiColors.violet}>Sonnet</tspan>
        <tspan fill={tuiColors.dim}> · 1.6k tok</tspan>
      </text>
      <text x={32} y={222} fontSize={11.5}>
        <tspan fill={tuiColors.green} fontWeight={700}>
          {"✓ "}
        </tspan>
        <tspan fill={tuiColors.dim}>[subagent] </tspan>
        <tspan fill="#e6e6e6">scan call sites of formatDate</tspan>
      </text>

      {/* Thinking indicator */}
      <text x={20} y={246} fontSize={12}>
        <tspan fill={tuiColors.amber} fontWeight={700}>
          {"⠙ "}
        </tspan>
        <tspan fill={tuiColors.amber}>Thinking… </tspan>
        <tspan fill={tuiColors.dim}>12s · ~1.8k tok · esc to cancel</tspan>
      </text>

      {/* Busy prompt bar. The real PromptInput glyph here is "⧗", but that
          codepoint falls back inconsistently across browser font stacks; "◐"
          (the in-progress glyph the same REPL uses for Task Progress rows —
          see agent-sidebar.tsx's taskStatusStyle) reads cleanly everywhere
          and carries the same "busy" meaning from the same icon vocabulary. */}
      <rect
        x={20}
        y={260}
        width={520}
        height={32}
        rx={8}
        fill="none"
        stroke={tuiColors.amber}
        strokeWidth={1.5}
      />
      <text
        x={34}
        y={281}
        fontSize={13}
        fill={tuiColors.amber}
        fontWeight={700}
      >
        {"◐"}
      </text>
    </TuiFrame>
  );
}
