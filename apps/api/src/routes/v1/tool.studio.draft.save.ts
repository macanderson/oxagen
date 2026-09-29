import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import {
  STUDIO_DRAFT_BODY_BYTES_MAX,
  toolStudioDraftSave,
} from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Save Studio's staged edits to one server folder as a draft. Mounted on the org-scoped router behind session auth. */
export const toolStudioDraftSaveRoute = new Hono<AppEnv>();

// The contract's size rules run after the body is parsed. This limit stops a
// body larger than any valid draft before the API buffers and parses it.
toolStudioDraftSaveRoute.use(
  "*",
  bodyLimit({
    maxSize: STUDIO_DRAFT_BODY_BYTES_MAX,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

toolStudioDraftSaveRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = toolStudioDraftSave.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(toolStudioDraftSave.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
