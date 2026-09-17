import { z } from "zod";

export const RunRow = z.object({
  runId: z.string().min(1),
  status: z.string(),
});
