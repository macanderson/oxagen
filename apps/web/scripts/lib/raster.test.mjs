import { describe, expect, it } from "vitest";
import { renderPng } from "./raster.mjs";

const svg = (w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#10100F"/></svg>`;

/** width and height from a PNG's IHDR chunk */
function size(png) {
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

describe("renderPng", () => {
  it("renders a PNG at the requested width, keeping the aspect", () => {
    const png = renderPng(svg(160, 90), { width: 800 });
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(size(png)).toEqual({ w: 800, h: 450 });
  });

  it("memoises on source and width", () => {
    const a = renderPng(svg(20, 10), { width: 40 });
    const b = renderPng(svg(20, 10), { width: 40 });
    const c = renderPng(svg(20, 10), { width: 20 });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(size(c)).toEqual({ w: 20, h: 10 });
  });

  it("keeps the cache bounded", () => {
    for (let i = 0; i < 520; i++)
      renderPng(svg(2 + (i % 50), 2), { width: 2 + i });
    const again = renderPng(svg(2, 2), { width: 2 });
    expect(size(again)).toEqual({ w: 2, h: 2 });
  });
});
