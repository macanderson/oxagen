import { describe, expect, it } from "vitest";
import { ApprovalPendingError } from "./approval-pending";

const ROW_ID = "0192d4a8-0000-7000-8000-000000000008";
const PUBLIC_ID = "apr_01k5rt9xq7v3m8n2p4s6t8w1";
const EXPIRES_AT = "2026-09-24T10:05:00.000Z";

describe("ApprovalPendingError", () => {
  it("tells the model the approval's public id, the id Fleet and the parked card show", () => {
    const error = new ApprovalPendingError(
      "revoke_api_key",
      ROW_ID,
      EXPIRES_AT,
      PUBLIC_ID,
    );
    expect(error.message).toBe(
      `refused: revoke_api_key is waiting for approval ${PUBLIC_ID} until ${EXPIRES_AT}`,
    );
    expect(error.message).not.toContain(ROW_ID);
    // Waiters still key on the row, so the field keeps the uuid.
    expect(error.approvalId).toBe(ROW_ID);
    expect(error.approvalPublicId).toBe(PUBLIC_ID);
    expect(error.code).toBe("pending_approval");
  });

  it("names the row uuid when the writer returned no public id", () => {
    const error = new ApprovalPendingError(
      "revoke_api_key",
      ROW_ID,
      EXPIRES_AT,
    );
    expect(error.message).toBe(
      `refused: revoke_api_key is waiting for approval ${ROW_ID} until ${EXPIRES_AT}`,
    );
    expect(error.approvalPublicId).toBeUndefined();
  });
});
