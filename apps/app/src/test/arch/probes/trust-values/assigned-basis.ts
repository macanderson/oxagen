export function toCost(out: { observed: boolean; basis: string | null }) {
  const view = { basis: out.basis };
  view.basis = out.observed ? "gateway_observed" : null;
  return view;
}
