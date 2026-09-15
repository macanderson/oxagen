import { z } from "zod";

export const PublicId = z.string().regex(/^[a-z]+_[A-Za-z0-9]+$/);

export const Invitation = z.object({
  id: PublicId,
  orgId: PublicId.nullable(),
  runIds: z.array(PublicId),
  paid: z.boolean(),
  valid: z.boolean(),
});
