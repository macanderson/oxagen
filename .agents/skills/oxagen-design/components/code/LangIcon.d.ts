import * as React from "react";

export type LanguageKey =
  | "ts" | "tsx" | "js" | "jsx" | "py" | "python" | "go" | "rust" | "rs"
  | "bash" | "sh" | "shell" | "json" | "sql" | "cypher" | "graphql" | "curl" | "http";

/**
 * Small language glyph badge (TS / PY / GO …) for code tabs. Dependency-free;
 * pass a `language` key or a custom `node`.
 */
export interface LangIconProps {
  language?: string;
  node?: React.ReactNode;
  size?: number;
}

export function LangIcon(props: LangIconProps): React.ReactElement;
