// Probe for hardcoded-values.test.ts: lines 5, 9 to 18 and 20 each write a
// value the rule refuses. The comment on line 21 quotes a class and is not a
// value.
const recipe = `flex
  p-[3px]`;

export function Raw({ pct }: { pct: number }) {
  return (
    <div className={`gap-[10px] md:max-w-[720px] ${recipe}`}>
      <p className="bg-foreground/[0.35] [overflow-wrap:anywhere]">a</p>
      <p className="min-[67.5rem]:grid-cols-3 duration-200 rounded">b</p>
      <p className={`rounded-[${String(pct)}px]`}>c</p>
      <p style={{ width: 240 }}>d</p>
      <p style={{ padding: "6px 8px", left: `calc(${String(pct)}% - 12px)` }}>e</p>
      <p style={{ height: pct > 1 ? 32 : undefined }}>f</p>
      <button type="button">g</button>
      <svg fill="white">
        <path stroke={"black"} />
      </svg>
      <p style={{ color: "red" }}>h</p>
      {/* `gap-[10px]` */}
    </div>
  );
}
