import { z } from "zod";
import { PublicId } from "./ok";

const Base = z.object({ id: PublicId });
const agentId = z.string();

export const ApprovalItem = Base.extend({
  requestedById: z.string(),
  agentId,
});
