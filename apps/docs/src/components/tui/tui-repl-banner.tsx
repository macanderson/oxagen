import { TuiFrame } from "./tui-frame";
import { CLI_VERSION, tuiColors, tuiGlyphs } from "./tui-theme";

/**
 * The block-letter OXAGEN wordmark exactly as shipped in
 * apps/cli/src/tui/banner.tsx — kept as a literal so this re-creation can
 * never silently drift from the real REPL banner.
 */
const WORDMARK: readonly string[] = [
  " ██████  ██   ██  █████   ██████  ███████ ███    ██",
  "██    ██  ██ ██  ██   ██ ██       ██      ████   ██",
  "██    ██   ███   ███████ ██   ███ █████   ██ ██  ██",
  "██    ██  ██ ██  ██   ██ ██    ██ ██      ██  ██ ██",
  " ██████  ██   ██ ██   ██  ██████  ███████ ██   ████",
];

/**
 * TuiReplBanner — the first thing you see: `oxagen` opens with the wordmark
 * banner, then drops straight into the empty prompt bar. This is the "agent in
 * your terminal" first impression for the CLI overview page, showing exactly
 * what apps/cli/src/tui/banner.tsx renders plus the live prompt/status chrome
 * from apps/cli/src/repl/components.tsx (PromptInput, StatusLine).
 */
export function TuiReplBanner({ className }: { className?: string }) {
  return (
    <TuiFrame
      id="tui-banner"
      title="~/acme-web — oxagen"
      width={560}
      height={222}
      className={className}
    >
      {WORDMARK.map((line, i) => (
        <text
          key={i}
          x={20}
          y={48 + i * 13}
          fontSize={9}
          fill={tuiColors.violet}
          fontWeight={700}
        >
          {line}
        </text>
      ))}

      <text x={20} y={125} fontSize={13}>
        <tspan className="tui-pulse" fill={tuiColors.cyan} fontWeight={700}>
          {tuiGlyphs.ring}{" "}
        </tspan>
        <tspan fill={tuiColors.violet} fontWeight={700}>
          Oxagen
        </tspan>
        <tspan
          fill={tuiColors.dim}
        >{`  ·  agentic coding CLI  ·  v${CLI_VERSION}`}</tspan>
      </text>

      {/* Prompt bar */}
      <rect
        x={20}
        y={144}
        width={520}
        height={32}
        rx={8}
        fill="none"
        stroke={tuiColors.cyan}
        strokeWidth={1.5}
      />
      <text x={34} y={165} fontSize={13}>
        <tspan fill={tuiColors.cyan} fontWeight={700}>
          {tuiGlyphs.pointer}{" "}
        </tspan>
        <tspan fill={tuiColors.dim}>
          refactor the billing meter to bill per-seat
        </tspan>
      </text>
      <rect
        className="tui-caret"
        x={330}
        y={153}
        width={7}
        height={15}
        fill={tuiColors.cyan}
        opacity={0.85}
      />

      {/* Status line */}
      <text x={20} y={196} fontSize={11.5}>
        <tspan fill={tuiColors.violet} fontWeight={700}>
          claude-sonnet-5
        </tspan>
        <tspan fill={tuiColors.dim}>{"  │  "}</tspan>
        <tspan fill={tuiColors.cyan}>main</tspan>
        <tspan fill={tuiColors.dim}>{"  │  "}</tspan>
        <tspan fill={tuiColors.cyan}>↑0 </tspan>
        <tspan fill={tuiColors.green}>↓0</tspan>
        <tspan fill={tuiColors.dim}>{"  │  "}</tspan>
        <tspan fill={tuiColors.amber}>~$0.00</tspan>
      </text>
      <text x={20} y={212} fontSize={11.5}>
        <tspan fill={tuiColors.cyan} fontWeight={700}>
          {"▶▶ ask before edits"}
        </tspan>
        <tspan fill={tuiColors.dim}> (shift+tab to cycle)</tspan>
      </text>
    </TuiFrame>
  );
}
