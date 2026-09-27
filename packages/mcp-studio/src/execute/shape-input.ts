// shape-input.ts: turn the agent's arguments into the upstream's
// (mcp-studio-spec, Call path, Shape the input).
//
// The agent sees the effective inputSchema: hidden and fixed inputs are gone,
// defaults are optional, and renamed inputs carry their new names. This undoes
// each of those, in order, so the Sender receives arguments in the upstream's
// own names:
//
// 1. Each renamed input goes back to its upstream name. A key that is the
//    upstream name of a renamed input is dropped, because the agent never saw
//    that name.
// 2. Hidden inputs are dropped.
// 3. Each default fills an input the agent left out.
// 4. Each fixed value is set, over anything the agent sent.
//
// Every other argument passes through as the agent sent it. An argument whose
// value is undefined counts as absent.
import type { ManifestShaping } from "../contract/manifest";

type InputShaping = Pick<ManifestShaping, "hide" | "fixed" | "defaults" | "rename">;

/** The upstream arguments for one call. The agent's object is never changed. */
export function shapeArguments(args: Readonly<Record<string, unknown>>, shaping: InputShaping): Record<string, unknown> {
  // rename maps an upstream name to the name the agent sees.
  const toUpstream = new Map<string, string>();
  for (const [upstream, agent] of Object.entries(shaping.rename)) toUpstream.set(agent, upstream);
  const renamedAway = new Set(Object.keys(shaping.rename));

  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const upstream = toUpstream.get(key);
    if (upstream !== undefined) out.set(upstream, value);
    else if (!renamedAway.has(key)) out.set(key, value);
  }

  for (const name of shaping.hide) out.delete(name);
  for (const [name, value] of Object.entries(shaping.defaults)) {
    if (out.get(name) === undefined) out.set(name, structuredClone(value));
  }
  for (const [name, value] of Object.entries(shaping.fixed)) out.set(name, structuredClone(value));

  // fromEntries defines own properties, so a key such as __proto__ stays data.
  return Object.fromEntries(out);
}
