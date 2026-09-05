import { TuiFrame } from "./tui-frame";
import { tuiColors, tuiGlyphs } from "./tui-theme";

interface ResultRow {
  kind: string;
  label: string;
  score: string;
}

const KIND_COLOR: Record<string, string> = {
  file: tuiColors.cyan,
  symbol: tuiColors.green,
  entity: tuiColors.violet,
};

/** Matches `oxagen graph search -q "…" -k file,symbol,entity` in the
 *  Knowledge graph doc page's example. */
const RESULTS: readonly ResultRow[] = [
  {
    kind: "file",
    label: "apps/api/src/middleware/tenant-scope.ts",
    score: "0.91",
  },
  { kind: "symbol", label: "withTenantDb", score: "0.88" },
  { kind: "entity", label: "Tenant Isolation Policy", score: "0.79" },
];

/**
 * TuiGraphSearch — `oxagen graph search`, a semantic query against the local
 * knowledge-graph replica. Each result is tagged with its node kind, colored
 * from the same brand palette every other TUI status surface uses, and a
 * similarity score — the CLI's terminal-native answer to the app's `NodeRef`
 * citation chip.
 */
export function TuiGraphSearch({ className }: { className?: string }) {
  return (
    <TuiFrame
      id="tui-graph-search"
      title="~/acme-web — oxagen"
      width={560}
      height={222}
      className={className}
    >
      <text x={20} y={48} fontSize={12.5}>
        <tspan fill={tuiColors.cyan} fontWeight={700}>
          {tuiGlyphs.pointer}{" "}
        </tspan>
        <tspan fill="#f5f5f5">
          oxagen graph search -q &quot;where do we enforce tenant
          isolation?&quot;
        </tspan>
      </text>

      {RESULTS.map((r, i) => {
        const y = 78 + i * 24;
        return (
          <g key={r.label}>
            <text
              x={20}
              y={y}
              fontSize={11.5}
              fill={KIND_COLOR[r.kind]}
              fontWeight={700}
            >
              [{r.kind}]
            </text>
            <text x={92} y={y} fontSize={12} fill="#e6e6e6">
              {r.label}
            </text>
            <text
              x={490}
              y={y}
              fontSize={11.5}
              fill={tuiColors.amber}
              textAnchor="end"
            >
              {r.score}
            </text>
          </g>
        );
      })}

      <text x={20} y={164} fontSize={11} fill={tuiColors.dim}>
        3 results · 84ms · online · workspace scoped
      </text>

      <text x={20} y={196} fontSize={13}>
        <tspan fill={tuiColors.cyan} fontWeight={700}>
          {tuiGlyphs.pointer}{" "}
        </tspan>
      </text>
      <rect
        className="tui-caret"
        x={34}
        y={184}
        width={7}
        height={15}
        fill={tuiColors.cyan}
        opacity={0.85}
      />
    </TuiFrame>
  );
}
