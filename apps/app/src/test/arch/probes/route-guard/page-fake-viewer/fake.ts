// A sibling wrapper with the seam's name: the guard must not take the name as
// proof that the viewer was resolved.
export async function requireViewer(org: string): Promise<{ org: string }> {
  return { org };
}
