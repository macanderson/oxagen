/** Rewrites xmcp's runtime to pass each tool's raw input shape to the MCP SDK. */
declare function rawInputShape(this: { resourcePath?: string } | void, source: string): string;
export = rawInputShape;
