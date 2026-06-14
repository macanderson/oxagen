import * as React from "react";

export type NodeKind = "user" | "document" | "service" | "policy" | "resource" | "default";

/**
 * A knowledge-graph node reference: a typed colour dot + mono node id (and an
 * optional human label). Mirrors how the product renders entities in semantic
 * edge diagrams and agent tool output.
 *
 * @startingPoint section="Brand" subtitle="Typed knowledge-graph node reference chip" viewport="700x100"
 */
export interface NodeChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  kind?: NodeKind;
  /** Mono node id, e.g. "prn_8fa21c". */
  id?: string;
  /** Optional human-readable label shown before the id. */
  label?: string;
}

export function NodeChip(props: NodeChipProps): React.ReactElement;
