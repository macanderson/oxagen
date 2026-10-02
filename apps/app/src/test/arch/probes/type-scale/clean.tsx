// Probe for type-scale.test.ts: every size here comes from a token or sits
// above the floor, so the scan finds nothing.
export function Clean() {
  return (
    <div className="text-xs text-sm md:text-base text-a-body text-[var(--fg)]">
      <p style={{ fontSize: "var(--ox-a-body)" }}>a</p>
      <p style={{ fontSize: 16 }}>b</p>
      <svg>
        <text className="text-sm">c</text>
      </svg>
    </div>
  );
}
