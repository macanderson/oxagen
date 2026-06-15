import * as React from "react";

export interface CodeTab {
  language: string;
  label?: string;
  filename?: string;
  code: string;
}

/**
 * Multi-language code sample: a tab per language (with its glyph), a copy button
 * bound to the active tab, and a fade transition between languages. The dev-docs
 * "same call in TS / Python / cURL" pattern.
 *
 * @startingPoint section="Code" subtitle="Tabbed multi-language code sample" viewport="700x260"
 */
export interface CodeTabsProps {
  tabs: CodeTab[];
  defaultIndex?: number;
  showLineNumbers?: boolean;
  style?: React.CSSProperties;
}

export function CodeTabs(props: CodeTabsProps): React.ReactElement;
