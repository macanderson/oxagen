export function toRun(
  out: { cost: { micros: string } | null; frames: unknown[] },
  index: number,
) {
  return {
    cost: out.cost ?? null,
    frameCount: out.frames.length,
    first: index === 0,
    page: out.frames.slice(0, 20),
  };
}
