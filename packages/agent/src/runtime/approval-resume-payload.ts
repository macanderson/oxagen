import { encrypt, decrypt } from "@oxagen/crypto";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import { z } from "zod";

const KEY_ID = "approval_resume_v1";
export const approvalResumePayloadSchema = z
  .object({
    version: z.literal(1),
    orgId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    requesterUserId: z.string().uuid(),
    messageId: z.string().uuid(),
    capabilityName: z.string(),
    rawInput: z.unknown(),
    validatedDigest: z.string(),
    riskLevel: z.enum(["low", "medium", "high"]),
  })
  .strict();
export type ApprovalResumePayload = z.infer<typeof approvalResumePayloadSchema>;

export class ApprovalResumeError extends Error {
  readonly code = "approval_resume_refused";
  constructor(readonly reason: string) {
    super(`Approved call cannot resume: ${reason}`);
    this.name = "ApprovalResumeError";
  }
}

function adapter() {
  const key = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new ApprovalResumeError("encryption_key_missing");
  return createLocalKmsAdapter(loadMasterKey(key));
}

export async function encryptApprovalResume(payload: ApprovalResumePayload) {
  const parsed = approvalResumePayloadSchema.parse(payload);
  const ciphertext = await encrypt(JSON.stringify(parsed), KEY_ID, {
    adapter: adapter(),
  });
  return {
    version: 1,
    keyId: KEY_ID,
    ciphertext: ciphertext.toString("base64"),
  };
}

export async function decryptApprovalResume(
  stored: unknown,
): Promise<ApprovalResumePayload> {
  const envelope = z
    .object({
      version: z.literal(1),
      keyId: z.literal(KEY_ID),
      ciphertext: z.string(),
    })
    .strict()
    .parse(stored);
  const plaintext = await decrypt(
    Buffer.from(envelope.ciphertext, "base64"),
    KEY_ID,
    { adapter: adapter() },
  );
  return approvalResumePayloadSchema.parse(
    JSON.parse(plaintext.toString("utf8")),
  );
}
