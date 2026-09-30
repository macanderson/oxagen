// Scratch proof for #3428. Do not merge: the explicit `any` is a planted
// lint error, one of two in separate packages.
export function z2ProofWork(value: any): unknown {
  return value;
}
