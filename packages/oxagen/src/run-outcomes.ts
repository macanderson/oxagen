import { z } from "zod";

export const runIssueDestinationSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("github"),
      owner: z.string().min(1).max(100),
      repo: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      provider: z.literal("linear"),
      connectionId: z.string().min(1),
      teamId: z.string().uuid(),
      projectId: z.string().uuid().optional(),
    })
    .strict(),
]);
export type RunIssueDestination = z.output<typeof runIssueDestinationSchema>;

export const runIssueReceiptSchema = z
  .object({
    provider: z.enum(["github", "linear"]),
    destination: runIssueDestinationSchema,
    issueId: z.string().min(1),
    identifier: z.string().min(1),
    url: z.string().url(),
  })
  .strict();
export type RunIssueReceipt = z.output<typeof runIssueReceiptSchema>;
