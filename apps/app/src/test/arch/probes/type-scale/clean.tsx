// Probe for type-scale.test.ts: every size here comes from the scale, so the
// scan finds nothing.
export function Clean() {
  return (
    <div className="text-xs text-sm md:text-base text-a-body text-a-micro text-[var(--fg)]">
      <p style={{ fontSize: "var(--ox-a-body)" }}>a</p>
      <p className="max-md:text-(length:--ox-a-h4)">b</p>
      <svg>
        <text className="text-xs">c</text>
      </svg>
      <p style={{ fontSize: Math.round(24 * 0.58) }}>d</p>
    </div>
  );
}
