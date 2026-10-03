// Probe for hardcoded-values.test.ts: every value here comes from a scale
// step, a token, or data, so the scan finds nothing.
import { Button } from "@/ui/button";

export function Clean({ pct, size }: { pct: number; size: number }) {
  return (
    <div className="gap-2.5 max-w-180 data-[state=open]:bg-hl aria-[sort=ascending]:text-foreground has-[>svg]:gap-2 group-data-[collapsible=icon]:hidden peer-data-[side=top]:flex supports-[display:grid]:grid [&>svg]:size-4 w-(--sidebar-width) ease-out duration-(--motion-base) before:rounded-[inherit]">
      <p style={{ width: `${String(pct)}%` }}>a</p>
      <p style={{ width: size, height: size }}>b</p>
      <p style={{ display: "none", color: "var(--foreground)" }}>c</p>
      <Button variant="ghost">d</Button>
      <svg fill="currentColor" stroke="none">
        <path fill="transparent" />
      </svg>
      {/* `gap-[10px]` */}
    </div>
  );
}
