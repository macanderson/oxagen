import { TuiZoom } from "./tui-frame";
import { tuiColors } from "./tui-theme";

interface SlashRow {
  name: string;
  argHint?: string;
  desc: string;
  /** Productized (builtin/CLI) commands carry the lock marker; custom ones don't. */
  locked: boolean;
  selected?: boolean;
}

/**
 * A representative slice of the real catalog (apps/cli/src/slash/catalog.ts):
 * three builtins, one CLI-sourced command, and one project-defined custom
 * command — so the crop shows both the lock marker and its absence, exactly
 * as apps/cli/src/repl/slash-menu.tsx renders it.
 */
const ROWS: readonly SlashRow[] = [
  { name: "help", desc: "List the slash commands", locked: true },
  {
    name: "mode",
    argHint: "[ask|auto-edit|bypass|readonly]",
    desc: "Show or set the tool-permission mode",
    locked: true,
    selected: true,
  },
  {
    name: "panel",
    desc: "Toggle the Agent Team + Task side panel",
    locked: true,
  },
  {
    name: "replay",
    argHint: "[n|id]",
    desc: "Replay how a past turn was handled",
    locked: true,
  },
  {
    name: "triage",
    argHint: "<ticket>",
    desc: "Investigate and triage a support ticket",
    locked: false,
  },
];

const ROW_HEIGHT = 42;

/**
 * TuiSlashMenu — a zoomed crop of the `/` typeahead dropdown
 * (apps/cli/src/repl/slash-menu.tsx). Command names always render bold amber
 * with argument hints in green — never per-command colors, and the menu
 * marks productized commands with a monochrome lock glyph instead. The
 * violet-bordered inner panel is the menu's own chrome; the outer crop frame
 * is just the "this is a close-up" affordance.
 */
export function TuiSlashMenu({ className }: { className?: string }) {
  const innerX = 16;
  const innerY = 16;
  const innerWidth = 528;
  const innerHeight = 16 + ROWS.length * ROW_HEIGHT + 30;
  const height = innerHeight + 32;

  return (
    <TuiZoom
      id="tui-slash-menu"
      title="Slash-command menu"
      width={560}
      height={height}
      className={className}
    >
      <rect
        x={innerX}
        y={innerY}
        width={innerWidth}
        height={innerHeight}
        rx={8}
        fill="none"
        stroke={tuiColors.violet}
        strokeWidth={1.5}
      />
      {ROWS.map((row, i) => {
        const rowY = innerY + 26 + i * ROW_HEIGHT;
        return (
          <g key={row.name}>
            {row.selected ? (
              <text
                x={innerX + 14}
                y={rowY}
                fontSize={13}
                fill={tuiColors.cyan}
                fontWeight={700}
                className="tui-pulse"
              >
                {"❯"}
              </text>
            ) : null}
            {row.locked ? (
              <text x={innerX + 30} y={rowY} fontSize={11} fill={tuiColors.dim}>
                {"\u{1F512}︎"}
              </text>
            ) : null}
            <text x={innerX + 52} y={rowY} fontSize={13.5}>
              <tspan fill={tuiColors.amber} fontWeight={700}>
                /{row.name}
              </tspan>
              {row.argHint ? (
                <tspan fill={tuiColors.green}>{`  ${row.argHint}`}</tspan>
              ) : null}
            </text>
            <text
              x={innerX + 52}
              y={rowY + 17}
              fontSize={11.5}
              fill="rgba(255,255,255,0.72)"
            >
              {row.desc}
            </text>
          </g>
        );
      })}
      <text
        x={innerX + 14}
        y={innerY + innerHeight - 12}
        fontSize={11}
        fill={tuiColors.dim}
      >
        5/23 · ↑↓ navigate · ⇥ complete · ↵ run · esc dismiss
      </text>
    </TuiZoom>
  );
}
