// Probe for type-scale.test.ts: lines 5 to 12 each set a size the floor
// refuses. The comment on line 13 quotes the mockup and is not a size.
export function Raw() {
  return (
    <div className="text-[13px]">
      <p className="font-medium md:text-[12.5px]">a</p>
      <p className="text-[0.92em]">b</p>
      <p className="text-[length:11px]">c</p>
      <p className="text-a-micro">d</p>
      <p style={{ fontSize: 12 }}>e</p>
      <svg><text fontSize={10.5}>f</text></svg>
      <p style={{ fontSize: "var(--ox-a-micro)" }}>g</p>
      {/* `.k { font-size:10px }` */}
    </div>
  );
}
