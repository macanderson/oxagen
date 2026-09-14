// A sibling wrapper with the seam's name, handed to an otherwise conforming
// delegate: the guard must refuse the handoff.
export async function resolveViewer(
  _org: string,
  _ws: string,
): Promise<{ kind: string }> {
  return { kind: "ok" };
}
