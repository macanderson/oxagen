// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { RecordCard } from "./record-card";

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("RecordCard", () => {
  it("heads the card with the statement under its kind, force and effect, with scope, lineage, badge and the caller's facts", () => {
    render(
      <IntlProvider>
        <RecordCard
          kind="constraint"
          force="must"
          constraintEffect="forbid"
          sharingScope="repository"
          lineageId="ctx.release.no-reread-changelog"
          statement="Do not re-read CHANGELOG.md after the first read in a run."
          badge={<span data-testid="badge" />}
        >
          <p data-testid="facts" />
        </RecordCard>
      </IntlProvider>,
    );
    const card = screen.getByRole("article");
    expect(card).toHaveAttribute("data-kind", "constraint");
    expect(card.querySelector('[data-term="kind"]')).toHaveTextContent(
      "constraint",
    );
    expect(card.querySelector('[data-term="force"]')).toHaveTextContent(
      "force must",
    );
    expect(
      card.querySelector('[data-term="constraint-effect"]'),
    ).toHaveTextContent("forbid");
    expect(card.querySelector('[data-term="scope"]')).toHaveTextContent(
      "Scoperepository",
    );
    expect(card.querySelector('[data-term="lineage"]')).toHaveTextContent(
      "Lineagectx.release.no-reread-changelog",
    );
    expect(screen.getByTestId("badge")).toBeInTheDocument();
    expect(screen.getByTestId("facts")).toBeInTheDocument();
  });

  it("prints unclassified and leaves out force and effect a record does not carry", () => {
    render(
      <IntlProvider>
        <RecordCard
          kind={null}
          force={null}
          constraintEffect={null}
          sharingScope="workspace"
          lineageId="release-notes"
          statement="Release notes format"
        />
      </IntlProvider>,
    );
    const card = screen.getByRole("article");
    expect(card).toHaveAttribute("data-kind", "unclassified");
    expect(card.querySelector('[data-term="kind"]')).toHaveTextContent(
      "unclassified",
    );
    expect(card.querySelector('[data-term="force"]')).toBeNull();
    expect(card.querySelector('[data-term="constraint-effect"]')).toBeNull();
  });
});
