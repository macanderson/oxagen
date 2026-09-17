import { z } from "zod";
import { PublicId } from "./ok";

export const RunPage = z.object({
  runs: z.array(z.object({ id: z.uuid(), name: z.string() })),
  cursor: PublicId.nullable(),
});
