// An rspack loader for xmcp's prebuilt runtime. It hands each tool's raw
// input shape to the MCP SDK, in place of the zod v4 object xmcp wraps it in.
//
// xmcp 0.6.13 registers a tool with `inputSchema: z.object(shape)`, built with
// the zod v4 it bundles. Every Oxagen tool's fields are zod v3, so the object
// was v4 and its fields were not. tools/list then converted the object with
// zod v4's JSON Schema code, which read `_zod.def` on a v3 field and failed:
// "Cannot read properties of undefined (reading 'def')" for all 356 tools
// (#4829). Given the raw shape, the SDK builds the object in the fields' own
// zod version.
//
// The runtime is minified, so the wrapper's name is whatever the pinned build
// chose. The loader requires exactly one match and fails the build otherwise,
// so an xmcp upgrade is rechecked here before it can deploy.

const WRAPPED_INPUT = /inputSchema:[A-Za-z_$][\w$]*\(u\),/g;

/**
 * @param {string} source
 * @returns {string}
 */
function rawInputShape(source) {
  const found = source.match(WRAPPED_INPUT) ?? [];
  if (found.length !== 1) {
    const where = (this && this.resourcePath) || "the xmcp runtime";
    throw new Error(
      `xmcp-raw-input-shape: expected one wrapped inputSchema in ${where}, found ${found.length}. ` +
        "Recheck this loader against the pinned xmcp before upgrading it.",
    );
  }
  return source.replace(WRAPPED_INPUT, "inputSchema:u,");
}

module.exports = rawInputShape;
