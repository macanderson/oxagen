// Probe for type-scale.test.ts: lines 5 to 13 each set a size by hand or use
// a step the scale does not map. The comment on line 14 quotes the mockup.
export function Raw() {
  return (
    <div className="text-[13px]">
      <p className="font-medium md:text-[12.5px]">a</p>
      <p className="text-[0.92em]">b</p>
      <p className="text-[length:11px]">c</p>
      <p style={{ fontSize: 16 }}>d</p>
      <p style={{ fontSize: "0.875rem" }}>e</p>
      <svg><text fontSize={10.5}>f</text></svg>
      <p style={{ font: "15px Arial" }}>g</p>
      <p className="text-7xl">h</p>
      {/* `.k { font-size:10px }` */}
    </div>
  );
}
