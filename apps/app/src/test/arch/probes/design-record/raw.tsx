// Probe for design-record.test.ts: a component that invents a colour and a font.
export function Raw() {
  return (
    <div className="bg-[#123abc]">
      <p style={{ color: "rgb(255, 0, 0)" }}>red</p>
      <p className="text-blue-500">blue</p>
      <p style={{ fontFamily: "Comic Sans MS" }}>comic</p>
      <p className="font-serif">serif</p>
    </div>
  );
}
