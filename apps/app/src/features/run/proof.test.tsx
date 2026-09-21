// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readOk, readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { ProofSection } from "./proof";
import { runProof } from "./run.builders";

afterEach(cleanup);
function draw(read: Parameters<typeof ProofSection>[0]["read"]) {
  return render(
    <IntlProvider>
      <ProofSection read={read} org="acme" ws="core-platform" />
    </IntlProvider>,
  );
}

describe("the proof record", () => {
  it("shows held-out witnesses, paired results and the recorded attestation", async () => {
    const { container } = draw(readOk(runProof()));
    expect(screen.getByTestId("proof-witness")).toHaveTextContent("Test flip");
    expect(screen.getByTestId("proof-witness")).toHaveTextContent("Yes");
    const details = container.querySelector("details");
    if (details) details.open = true;
    expect(screen.getByTestId("proof-attestation")).toHaveTextContent(
      "runner-key-1",
    );
    expect(screen.getByTestId("proof-attestation")).toHaveTextContent(
      "recorded-signature",
    );
    expect(screen.getByTestId("proof-attestation")).toHaveTextContent(
      "does not independently verify",
    );
    expect(screen.getByText("Fail")).toBeVisible();
    expect(screen.getByText("Pass")).toBeVisible();
    expect(
      screen.getAllByRole("link", { name: "arun_witness1" })[0],
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_witness1");
    expect(container).not.toHaveTextContent("certified");
    expect(
      screen.getByRole("region", { name: "Witness run costs" }),
    ).toHaveTextContent("not recorded");
    expect(screen.queryByTestId("money")).not.toBeInTheDocument();
    await expectNoAxe(container);
  });

  it("shows a broken fingerprint and a tampered verdict without a positive claim", () => {
    const proof = runProof({ verdict: "tampered" });
    const witness = proof.witnesses[0];
    const attempt = witness?.attempts[0];
    if (!witness || !attempt) throw new Error("Missing witness fixture");
    witness.verdict = "tampered";
    attempt.verdict = "tampered";
    attempt.tamperExclusion = "broken";
    attempt.tamper = {
      fingerprintAuthored: "sha256:before",
      fingerprintAtRun: "sha256:after",
    };
    const { container } = draw(readOk(proof));
    expect(container).toHaveTextContent("Tampered");
    expect(container).toHaveTextContent("Fingerprint changed");
    expect(container).toHaveTextContent("sha256:before");
    expect(container).toHaveTextContent("sha256:after");
    expect(container).not.toHaveTextContent("Flipped");
  });

  it("keeps an absent proof distinct from a recorded unverified verdict", async () => {
    const { container } = draw(
      readOk(runProof({ witnesses: [], witnessRuns: [], verdict: null })),
    );
    expect(screen.getByTestId("proof-empty")).toHaveTextContent(
      "No witness has reported",
    );
    expect(container).toHaveTextContent("not recorded");
    expect(container).not.toHaveTextContent("Unverified");
    await expectNoAxe(container);
  });

  it.each([
    readError("proof_store_unavailable", 502),
    { ok: false, reason: "denied", permission: "get_run_proof" } as const,
    {
      ok: false,
      reason: "pending_approval",
      accessRequestId: "apr_proof",
    } as const,
  ])(
    "shows a refused read instead of an empty record: $reason",
    async (read) => {
      const { container } = draw(read);
      expect(screen.queryByTestId("proof-empty")).not.toBeInTheDocument();
      expect(
        container.querySelector(`[data-reason="${read.reason}"]`),
      ).not.toBeNull();
      await expectNoAxe(container);
    },
  );
});
