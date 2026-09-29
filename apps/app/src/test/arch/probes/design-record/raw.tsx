// Probe for design-record.test.ts: a component that invents a colour and a font.
export function Raw() {
  return (
    <div className="bg-[#123abc]">
      <p style={{ color: "rgb(255, 0, 0)" }}>red</p>
      <p className="text-blue-500">blue</p>
      <p style={{ color: "#0000" }}>clear</p>
      <p style={{ color: "color-mix(in srgb, red, blue)" }}>mix</p>
      <p style={{ color: "light-dark(black, white)" }}>pair</p>
      <p style={{ color: "color(rec2020 1 0 0)" }}>wide</p>
      <p style={{ fontFamily: "Comic Sans MS" }}>comic</p>
      <p className="font-serif">serif</p>
      <p style={{ font: "15px Arial" }}>arial</p>
      <p style={{ font: '15px "Comic Sans MS"' }}>quoted</p>
      <p style={{ font: "var(--size) Arial" }}>sized</p>
    </div>
  );
}
