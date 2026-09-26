// @vitest-environment jsdom
// The Run page for a run whose host held the loop on a repository question
// (#3941, spec pages/run-interjection.md), rendered through `Run` over a fake
// DataSource: the waiting question with both paths, a link answer and a
// create answer sent from the page, each refusal the handler can give, the
// Send button disabled with its reason, the window that ran out, and the
// question once it is answered or timed out. Every state gets an axe check.
//
// Two rules the tests hold the page to. The page never claims more than the
// record holds: a frame that has not happened carries no time, and a read that
// stopped early claims no pending model call. And the page is drawn only for a
// run whose own chain carries the question, and only with no tab named, so
// every other Run page makes no read of the run's questions.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InterjectionItem,
  InterjectionQueue,
} from "@/data/contracts/interjections";
import type { RunDetail, RunFrame } from "@/data/contracts/run";
import { type Read, readOk } from "@/data/read";
import type { OrgRole, WsRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  heldFrames,
  NOW,
  runDetail,
  runFrame,
  runInterjection,
  runRow,
  runSource,
} from "./run.builders";

const { answerInterjection, refresh } = vi.hoisted(() => ({
  answerInterjection: vi.fn(),
  refresh: vi.fn(),
}));
// jsdom has no layout, so it has no scrollIntoView; the ordinary page calls it.
Element.prototype.scrollIntoView = vi.fn();
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../run-outcomes/actions", () => ({
  setRunOutcomesConsentAction: vi.fn(),
}));
vi.mock("../run-outcomes/provider-actions", () => ({
  loadRunIssueProviders: vi.fn(),
  authorizeRunIssues: vi.fn(),
}));
vi.mock("./actions", () => ({
  haltRun: vi.fn(),
  steerRun: vi.fn(),
  summarizeRun: vi.fn(),
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
  sealRun: vi.fn(),
  answerInterjection,
}));
vi.mock("next-intl/server", async () => {
  const { translator } = await import("@/test/intl");
  return { getTranslations: (namespace?: string) => translator(namespace) };
});
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Run } = await import("./run");

/** A viewer of core-platform holding these two roles. */
function viewer(orgRole: OrgRole, wsRole: WsRole) {
  return unsafeMint(WsCtx, {
    userId: "usr_marcusbell",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
    workspaceId: "7b000000-0000-4000-8000-000000000001",
    wsSlug: "core-platform",
    wsName: "Core platform",
    wsRole,
  });
}

/** An organization Owner: the handler admits a path answer from this role. */
const owner = viewer("owner", "member");

/** `secondsFromNow` after the instant every test renders at, as a contract instant. */
const iso = (secondsFromNow: number): string =>
  new Date(NOW + secondsFromNow * 1000).toISOString();

/** The run the host held: live, three frames recorded, the question the last. */
const HELD_RUN = runRow({
  status: "live",
  outcome: "running",
  sealedAt: null,
  frames: 3,
});

const RECEIPT = "rcp_4k8d2m9q7w1x3z5v6b8n0p";

function held(frames: RunFrame[] = heldFrames(), more = false): RunDetail {
  return runDetail({
    run: HELD_RUN,
    frames: { frames, cursor: more ? "ZjoxOn3" : null, more },
  });
}

/** One question row, and nothing more to read. */
const questions = (items: InterjectionItem[]): Read<InterjectionQueue> =>
  readOk({ items, more: false });

async function renderHeld({
  detail = held(),
  interjections = questions([runInterjection()]),
  ctx = owner,
  tab = null,
}: {
  detail?: RunDetail;
  /** `interjections.forRun`; `"throws"` makes the read reject. */
  interjections?: Read<InterjectionQueue> | "throws";
  ctx?: ReturnType<typeof viewer>;
  tab?: string | null;
} = {}) {
  const { source, calls } = runSource({
    detail: readOk(detail),
    ...(interjections === "throws" ? {} : { interjections }),
  });
  const element = await Run({
    ctx,
    source,
    runId: "tse_7k2m9q",
    tab,
    kinds: null,
    frames: null,
    body: null,
    reads: null,
    spine: null,
    now: NOW,
  });
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<IntlProvider>{element}</IntlProvider>));
    await Promise.resolve();
  });
  return { container, calls };
}

/**
 * A pick card's consequence lines as a screen reader meets them: the list the
 * card's button names in `aria-describedby`, each line with its mark, its
 * glyph, the word the glyph stands for, and the sentence.
 */
function linesOf(path: "link" | "create"): [string | undefined, string][] {
  const id = screen
    .getByTestId(`interjection-pick-${path}`)
    .getAttribute("aria-describedby");
  const list = id === null ? null : document.getElementById(id);
  if (list === null) throw new Error(`the ${path} card names no list`);
  return [...list.querySelectorAll("li")].map((li) => [
    li.dataset.mark,
    li.textContent,
  ]);
}

/**
 * Submits the answer form directly, as a keyboard Enter or a script would,
 * so a test can prove the form sends nothing while Send is held.
 */
function forceSubmit(): void {
  const form = screen.getByTestId("interjection-send").closest("form");
  if (form === null) throw new Error("Send sits outside a form");
  fireEvent.submit(form);
}

/** What `answer_interjection` answers for a link to core-platform. */
const LINKED = {
  interjectionId: "inj_7w2k9d",
  runId: "tse_7k2m9q",
  answeredAt: iso(0),
  commandIds: ["tcm_5h2j8k"],
  receiptId: RECEIPT,
  path: "link",
  repository: { bindingId: "rpb_3n6q1s", fullName: "acme/edge-proxy" },
  workspace: null,
};

/** The same, for a new workspace under the slug the person typed. */
const CREATED = {
  ...LINKED,
  path: "create",
  workspace: { publicId: "wsp_8c1v4b", slug: "edge-proxy-2" },
};

beforeEach(() => {
  answerInterjection.mockReset();
  refresh.mockReset();
});

afterEach(cleanup);

describe("the waiting question", () => {
  it("reads the run's questions once, by the run's id, and draws the question, both paths and the timeout", async () => {
    const { container, calls } = await renderHeld();
    expect(calls.interjections).toEqual([[owner, "tse_7k2m9q"]]);
    const page = screen.getByTestId("run-interjection");
    expect(page).toHaveAttribute("data-stage", "waiting");

    // The header: the run, its facts and its state.
    expect(
      screen.getByRole("heading", { level: 1, name: "Cut the 3.2 release branch" }),
    ).toBeInTheDocument();
    const facts = within(screen.getByRole("list", { name: "Run facts" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(facts).toEqual([
      "acme.core.release-bot",
      "Claude Code",
      "Marcus Bell",
      "harness tier",
      "acme/edge-proxy",
    ]);
    expect(screen.getByTestId("interjection-status")).toHaveTextContent(
      "pausedwaiting on a person",
    );
    expect(screen.getByTestId("interjection-note")).toHaveTextContent(
      "The loop is stopped. The harness is holding before its first model call. Nothing has been charged since 08:59:00Z.",
    );

    // Oxagen's bubble carries the question the host raised.
    const bubble = screen.getByTestId("interjection-question");
    expect(bubble).toHaveTextContent("Oxagenquestion08:59:00Z");
    expect(bubble).toHaveTextContent(
      "Oxagen is holding this session before its first model call.",
    );

    // Both pick cards, each with its description and its consequence lines.
    expect(screen.getByTestId("interjection-pick-link")).toHaveTextContent(
      "Link it to core-platformBecomes a linked repository of core-platform.",
    );
    expect(linesOf("link")).toEqual([
      ["gain", "+Gains Uses the skills configuration skl_v7."],
      ["gain", "+Gains core-platform pins 7 skills."],
      ["same", "·Unchanged core-platform links 2 other repositories."],
      [
        "loss",
        "−Loses This repository's spend and audit are recorded under core-platform.",
      ],
    ]);
    expect(screen.getByTestId("interjection-pick-create")).toHaveTextContent(
      "Create a new workspaceCalled edge-proxy, with this repository as its main repository.",
    );
    expect(linesOf("create")).toEqual([
      [
        "loss",
        "−Loses Skills ship off. The run resolves no skills in the new workspace.",
      ],
      ["gain", "+Gains Its own spend, audit, and owner."],
      ["same", "·Unchanged The run goes on with either path."],
    ]);
    for (const path of ["link", "create"] as const) {
      const pick = screen.getByTestId(`interjection-pick-${path}`);
      expect(pick).toHaveAttribute("aria-pressed", "false");
      expect(pick).toBeEnabled();
    }

    // Send is disabled until a pick, and the line beside it says so.
    const send = screen.getByTestId("interjection-send");
    expect(send).toHaveTextContent("Send this answer");
    expect(send).toBeDisabled();
    expect(screen.getByTestId("interjection-send-hint")).toHaveTextContent(
      "pick one",
    );
    expect(send).toHaveAccessibleDescription("pick one");

    // The operator pane: the held question, the repository and the timeout.
    const operator = screen.getByTestId("interjection-operator");
    expect(operator).toHaveTextContent("control.interjectthe loop is held");
    expect(screen.getByTestId("interjection-repository")).toHaveTextContent(
      "acme/edge-proxy matches no workspace in this organization.",
    );
    expect(screen.getByTestId("interjection-timeout")).toHaveTextContent(
      "If nobody answersAt 30 minutes this times out to deny. The run continues with no skills, and the agent is told why.The window closes at 09:29:00Z.",
    );
    expect(screen.queryByTestId("interjection-answer")).toBeNull();

    // The frames: what the host recorded, then greyed rows with no time for
    // the answer and the first model call, which have not happened.
    const recorded = screen
      .getAllByTestId("interjection-frame")
      .map((row) => row.getAttribute("data-kind"));
    expect(recorded).toEqual(["agent_start", "repo.unknown", "control.interject"]);
    const pending = screen.getAllByTestId("interjection-frame-pending");
    expect(pending.map((row) => row.getAttribute("data-kind"))).toEqual([
      "control.answer",
      "llm_call",
    ]);
    expect(pending[0]).toHaveTextContent("control.answer waits on a person");
    expect(pending[1]).toHaveTextContent(
      "llm_call the first model call has not happened",
    );
    for (const row of pending) expect(row).not.toHaveTextContent(/\d\dZ/);
    await expectNoAxe(container);
  });

  it("says a read that stopped early stopped, and claims no pending model call (negative)", async () => {
    const { container } = await renderHeld({ detail: held(heldFrames(), true) });
    expect(
      screen
        .getAllByTestId("interjection-frame-pending")
        .map((row) => row.getAttribute("data-kind")),
    ).toEqual(["control.answer"]);
    expect(screen.getByTestId("interjection-frames")).toHaveTextContent(
      "This read stopped before the end of the recording, so later frames are not listed.",
    );
    await expectNoAxe(container);
  });

  it("leaves out a link fact the host did not count rather than guessing it", async () => {
    const base = runInterjection();
    const body = base.body;
    if (body === null) throw new Error("the builder's question has a body");
    const [link, create] = body.paths;
    const { container } = await renderHeld({
      interjections: questions([
        runInterjection({
          body: {
            ...body,
            paths: [
              {
                ...link,
                configVersion: null,
                skillsPinned: null,
                linkedRepositories: null,
              },
              { ...create, proposedName: null, proposedSlug: null },
            ],
          },
        }),
      ]),
    });
    expect(linesOf("link")).toEqual([
      [
        "loss",
        "−Loses This repository's spend and audit are recorded under core-platform.",
      ],
    ]);
    expect(screen.getByTestId("interjection-pick-create")).toHaveTextContent(
      "A new workspace with this repository as its main repository.",
    );
    await expectNoAxe(container);
  });

  it("answers the question the frame raised, not a free-text question or another repository question on the run", async () => {
    const { container } = await renderHeld({
      interjections: questions([
        runInterjection({
          id: "inj_2b5n8m",
          kind: "question",
          raisedSeq: null,
          question: "Which branch should the release cut from?",
          body: null,
        }),
        runInterjection({
          id: "inj_9x4c1v",
          raisedSeq: "9",
          question: "A later repository question.",
        }),
        runInterjection(),
      ]),
    });
    const bubble = screen.getByTestId("interjection-question");
    expect(bubble).toHaveTextContent("Oxagen is holding this session");
    expect(bubble).not.toHaveTextContent("Which branch");
    expect(bubble).not.toHaveTextContent("A later repository question.");
    await expectNoAxe(container);
  });
});

describe("sending an answer", () => {
  it("sends a link answer, says it is sending, then shows the receipt and re-reads the page", async () => {
    let settle!: (value: unknown) => void;
    answerInterjection.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    const { container } = await renderHeld();

    await user.click(screen.getByTestId("interjection-pick-link"));
    expect(screen.getByTestId("interjection-pick-link")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("interjection-pick-create")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // A link needs no name, so there is nothing to type.
    expect(screen.queryByTestId("interjection-create-name")).toBeNull();
    const send = screen.getByTestId("interjection-send");
    expect(send).toBeEnabled();
    expect(screen.getByTestId("interjection-send-hint")).toHaveTextContent(
      "answers in your name",
    );
    await expectNoAxe(container);

    await user.click(send);
    expect(answerInterjection).toHaveBeenCalledTimes(1);
    expect(answerInterjection).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "inj_7w2k9d",
      { path: "link" },
    );
    expect(screen.getByTestId("interjection-send")).toHaveTextContent(
      "Sending",
    );
    expect(screen.getByTestId("interjection-send")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // A second submit while the first is on its way sends nothing more.
    forceSubmit();
    expect(answerInterjection).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle({ ok: true, value: LINKED });
      await Promise.resolve();
    });
    const receipt = await screen.findByTestId("interjection-receipt");
    expect(receipt).toHaveAttribute("role", "status");
    expect(receipt).toHaveTextContent(
      `Answer recorded. Receipt ${RECEIPT}.Linked acme/edge-proxy to core-platform.`,
    );
    expect(screen.queryByTestId("interjection-send")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
    await expectNoAxe(container);
  });

  it("sends a create answer under the name and slug the person typed, and names the new workspace", async () => {
    answerInterjection.mockResolvedValue({ ok: true, value: CREATED });
    const user = userEvent.setup();
    const { container } = await renderHeld();

    await user.click(screen.getByTestId("interjection-pick-create"));
    const name = screen.getByLabelText("Workspace name");
    const slug = screen.getByLabelText("Workspace slug");
    // The host's proposal fills both fields.
    expect(name).toHaveValue("edge-proxy");
    expect(slug).toHaveValue("edge-proxy");
    expect(slug).toHaveAccessibleDescription(
      "2 to 40 lowercase letters, digits, and single hyphens.",
    );
    await expectNoAxe(container);

    // An empty name holds Send, and the line says what is missing.
    await user.clear(name);
    expect(screen.getByTestId("interjection-send")).toBeDisabled();
    expect(screen.getByTestId("interjection-send-hint")).toHaveTextContent(
      "Name the workspace and give it a slug.",
    );
    await expectNoAxe(container);

    await user.type(name, "Edge proxy");
    await user.clear(slug);
    await user.type(slug, "edge-proxy-2");
    await user.click(screen.getByTestId("interjection-send"));
    expect(answerInterjection).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "inj_7w2k9d",
      { path: "create", name: "Edge proxy", slug: "edge-proxy-2" },
    );
    expect(await screen.findByTestId("interjection-receipt")).toHaveTextContent(
      `Answer recorded. Receipt ${RECEIPT}.Created the workspace edge-proxy-2.`,
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    await expectNoAxe(container);
  });

  const REFUSALS = [
    {
      name: "a slug another workspace holds",
      failure: { ok: false, reason: "conflict", code: "slug_taken" },
      text: "A workspace in this organization already uses that slug. Choose another.",
    },
    {
      name: "a slug the contract refuses",
      failure: {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "create.slug",
      },
      text: "A slug takes 2 to 40 lowercase letters, digits, and single hyphens, and cannot be a reserved word.",
    },
    {
      name: "a name the contract refuses",
      failure: {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "create.name",
      },
      text: "A workspace name takes 1 to 120 characters.",
    },
    {
      name: "a question someone already answered",
      failure: { ok: false, reason: "conflict", code: "interjection_answered" },
      text: "Someone already answered this question. Re-read the run to see the answer.",
    },
    {
      name: "a window that closed on the way",
      failure: { ok: false, reason: "conflict", code: "interjection_expired" },
      text: "The answer window closed before this answer arrived. Nothing was linked or created.",
    },
    {
      name: "a role the handler refuses",
      failure: { ok: false, reason: "denied", code: "org_role_required" },
      text: "Your role cannot answer this question. An organization Owner or Admin, or the workspace Owner, can.",
    },
    {
      name: "a repository GitHub cannot see",
      failure: {
        ok: false,
        reason: "not_found",
        code: "repository_not_installed",
      },
      text: "The GitHub App installation cannot see this repository.",
    },
    {
      name: "a choice the action refuses",
      failure: {
        ok: false,
        reason: "invalid",
        code: "interjection_choice",
        field: "path",
      },
      text: "Pick link or create, then send.",
    },
    {
      name: "a code the page has no sentence for",
      failure: { ok: false, reason: "conflict", code: "workspace_limit" },
      text: "Oxagen refused the answer: workspace_limit.",
    },
    {
      name: "an answer parked for approval",
      failure: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_2m7p4q",
      },
      text: "Your answer is waiting for approval. The request is acr_2m7p4q.",
    },
  ];

  it.each(REFUSALS)(
    "says why the answer was refused for $name, and keeps the form (negative)",
    async ({ failure, text }) => {
      answerInterjection.mockResolvedValue(failure);
      const user = userEvent.setup();
      const { container } = await renderHeld();
      await user.click(screen.getByTestId("interjection-pick-create"));
      await user.click(screen.getByTestId("interjection-send"));
      expect(
        await screen.findByTestId("interjection-failure"),
      ).toHaveTextContent(text);
      expect(screen.getByTestId("interjection-failure")).toHaveAttribute(
        "role",
        "alert",
      );
      expect(screen.queryByTestId("interjection-receipt")).toBeNull();
      expect(screen.getByTestId("interjection-send")).toHaveTextContent(
        "Send this answer",
      );
      expect(screen.getByTestId("interjection-send")).toBeEnabled();
      expect(refresh).not.toHaveBeenCalled();
      await expectNoAxe(container);

      // Picking again clears the old refusal.
      await user.click(screen.getByTestId("interjection-pick-link"));
      expect(screen.queryByTestId("interjection-failure")).toBeNull();
    },
  );

  it("says the answer was not recorded when the action throws before it answers (negative)", async () => {
    answerInterjection.mockRejectedValue(new Error("socket hang up"));
    const user = userEvent.setup();
    const { container } = await renderHeld();
    await user.click(screen.getByTestId("interjection-pick-link"));
    await user.click(screen.getByTestId("interjection-send"));
    expect(await screen.findByTestId("interjection-failure")).toHaveTextContent(
      "Oxagen could not record the answer: action_failed. Retry, and report the code if it repeats.",
    );
    expect(screen.queryByTestId("interjection-receipt")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    await expectNoAxe(container);
  });
});

describe("who can answer", () => {
  it("shows a workspace Member the question and why Send is disabled, and sends nothing (negative)", async () => {
    const { container } = await renderHeld({
      ctx: viewer("member", "member"),
    });
    expect(screen.getByTestId("interjection-question")).toHaveTextContent(
      "Oxagen is holding this session",
    );
    for (const path of ["link", "create"] as const)
      expect(screen.getByTestId(`interjection-pick-${path}`)).toBeDisabled();
    const reason =
      "Answering needs an organization Owner or Admin role, or the workspace Owner role.";
    const send = screen.getByTestId("interjection-send");
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("title", reason);
    expect(screen.getByTestId("interjection-send-hint")).toHaveTextContent(
      reason,
    );
    // Even a forced submit sends nothing.
    forceSubmit();
    expect(answerInterjection).not.toHaveBeenCalled();
    await expectNoAxe(container);
  });

  it("lets the workspace Owner answer whatever the organization role is", async () => {
    const { container } = await renderHeld({
      ctx: viewer("viewer", "owner"),
    });
    expect(screen.getByTestId("interjection-pick-link")).toBeEnabled();
    expect(screen.getByTestId("interjection-send-hint")).toHaveTextContent(
      "pick one",
    );
    expect(screen.getByTestId("interjection-send")).not.toHaveAttribute(
      "title",
    );
    await expectNoAxe(container);
  });
});

describe("a window that ran out", () => {
  it("says the window closed at its deadline, disables both paths and Send, and sends nothing (negative)", async () => {
    const { container } = await renderHeld({
      interjections: questions([
        runInterjection({ raisedAt: iso(-1900), expiresAt: iso(-100) }),
      ]),
    });
    expect(screen.getByTestId("run-interjection")).toHaveAttribute(
      "data-stage",
      "closed",
    );
    expect(screen.getByTestId("interjection-status")).toHaveTextContent(
      "paused",
    );
    expect(screen.getByTestId("interjection-status")).not.toHaveTextContent(
      "waiting on a person",
    );
    expect(screen.getByTestId("interjection-note")).toHaveTextContent(
      "The answer window closed at 08:58:20Z. Oxagen has not recorded the timeout yet.",
    );
    for (const path of ["link", "create"] as const)
      expect(screen.getByTestId(`interjection-pick-${path}`)).toBeDisabled();
    const send = screen.getByTestId("interjection-send");
    expect(send).toBeDisabled();
    expect(screen.getByTestId("interjection-send-hint")).toHaveTextContent(
      "The answer window closed at 08:58:20Z.",
    );
    // The timeout still says what happens, and no longer when it will.
    expect(screen.getByTestId("interjection-timeout")).not.toHaveTextContent(
      "The window closes at",
    );
    forceSubmit();
    expect(answerInterjection).not.toHaveBeenCalled();
    await expectNoAxe(container);
  });
});

describe("a settled question", () => {
  /** The frames after an answer at `answeredAt`: the answer, the first model call, then a tool call. */
  function answeredFrames(answeredAt: string, summary: string): RunFrame[] {
    return [
      ...heldFrames(),
      runFrame({
        cursor: "ZjoxOn4",
        seq: "4",
        type: "control.answer",
        stage: "control",
        summary,
        observedAt: answeredAt,
        cost: null,
      }),
      runFrame({
        cursor: "ZjoxOn5",
        seq: "5",
        type: "llm_call",
        stage: "act",
        summary: "anthropic · claude-sonnet-5",
        observedAt: iso(-19),
      }),
      runFrame({
        cursor: "ZjoxOn6",
        seq: "6",
        type: "tool.call",
        stage: "act",
        summary: "Read",
        observedAt: iso(-18),
      }),
    ];
  }

  it("draws a link answer: the reply, who chose which path, the receipt, the wait and the transcript link", async () => {
    const answer = "Linked acme/edge-proxy to the workspace core-platform.";
    const { container } = await renderHeld({
      detail: held(answeredFrames(iso(-20), "link")),
      interjections: questions([
        runInterjection({
          answeredAt: iso(-20),
          answer,
          answeredBy: "usr_marcusbell",
          path: "link",
          receiptId: RECEIPT,
        }),
      ]),
    });
    expect(screen.getByTestId("run-interjection")).toHaveAttribute(
      "data-stage",
      "answered",
    );
    // The header says what the run is doing: live, as the design has it.
    expect(screen.getByTestId("interjection-status")).toHaveTextContent("live");
    expect(screen.getByTestId("interjection-note")).toHaveTextContent(
      `Answered at 08:59:40Z. ${answer}`,
    );
    // No form once answered, and no timeout to wait on.
    expect(screen.queryByTestId("interjection-send")).toBeNull();
    expect(screen.queryByTestId("interjection-timeout")).toBeNull();
    expect(screen.getByTestId("interjection-operator")).not.toHaveTextContent(
      "the loop is held",
    );

    expect(screen.getByTestId("interjection-reply")).toHaveTextContent(
      `usr_marcusbellanswer08:59:40Z${answer}`,
    );
    const record = screen.getByTestId("interjection-answer");
    expect(
      within(record).getByRole("heading", { name: "Answer" }),
    ).toBeInTheDocument();
    expect(record).toHaveTextContent(
      `Answered byusr_marcusbellPathlinkReceipt${RECEIPT}Waited40 s`,
    );
    expect(screen.getByTestId("interjection-transcript")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=transcript",
    );

    // The frames stop at the first model call; the tool call after it is
    // the ordinary page's.
    expect(
      screen
        .getAllByTestId("interjection-frame")
        .map((row) => row.getAttribute("data-kind")),
    ).toEqual([
      "agent_start",
      "repo.unknown",
      "control.interject",
      "control.answer",
      "llm_call",
    ]);
    expect(screen.queryByTestId("interjection-frame-pending")).toBeNull();
    await expectNoAxe(container);
  });

  it("draws a create answer with its path and receipt", async () => {
    const answer =
      "Created the workspace edge-proxy for acme/edge-proxy, with skills off.";
    const { container } = await renderHeld({
      detail: held(answeredFrames(iso(-20), "create")),
      interjections: questions([
        runInterjection({
          answeredAt: iso(-20),
          answer,
          answeredBy: "usr_marcusbell",
          path: "create",
          receiptId: "rcp_7t3y6u9i2o5p8a1s4d7f0g",
        }),
      ]),
    });
    expect(screen.getByTestId("interjection-note")).toHaveTextContent(answer);
    expect(screen.getByTestId("interjection-answer")).toHaveTextContent(
      "PathcreateReceiptrcp_7t3y6u9i2o5p8a1s4d7f0g",
    );
    await expectNoAxe(container);
  });

  it("says an answer the row does not word or receipt was not recorded, rather than inventing either (negative)", async () => {
    const { container } = await renderHeld({
      detail: held(answeredFrames(iso(-20), "link")),
      interjections: questions([
        runInterjection({
          answeredAt: iso(-20),
          answer: null,
          answeredBy: "usr_marcusbell",
          path: null,
          receiptId: null,
        }),
      ]),
    });
    expect(screen.getByTestId("interjection-note")).toHaveTextContent(
      "Answered at 08:59:40Z. The answer's text is not recorded.",
    );
    expect(screen.getByTestId("interjection-answer")).toHaveTextContent(
      "Pathnot recordedReceiptnot recorded",
    );
    await expectNoAxe(container);
  });

  it("draws a question nobody answered as timed out, answered by the timeout", async () => {
    const text =
      "Oxagen asked a person whether to bind this repository to a workspace, and nobody answered in time. This session goes on without skills.";
    const { container } = await renderHeld({
      detail: held(answeredFrames(iso(-100), "deny")),
      interjections: questions([
        runInterjection({
          raisedAt: iso(-1900),
          expiresAt: iso(-100),
          answeredAt: iso(-100),
          answer: text,
          answeredBy: null,
          path: "deny",
          receiptId: RECEIPT,
        }),
      ]),
    });
    expect(screen.getByTestId("run-interjection")).toHaveAttribute(
      "data-stage",
      "timedOut",
    );
    expect(screen.getByTestId("interjection-note")).toHaveTextContent(
      "Nobody answered in time. The question closed at 08:58:20Z, and the run went on without skills.",
    );
    expect(screen.getByTestId("interjection-reply")).toHaveTextContent(
      `Timeoutanswer08:58:20Z${text}`,
    );
    expect(screen.getByTestId("interjection-answer")).toHaveTextContent(
      `Answered bythe timeoutPathdenyReceipt${RECEIPT}Waited30:00`,
    );
    expect(screen.queryByTestId("interjection-send")).toBeNull();
    await expectNoAxe(container);
  });
});

describe("a question the page cannot read", () => {
  it("says the question is not recorded yet when the run has no row for it (negative)", async () => {
    const { container } = await renderHeld({ interjections: questions([]) });
    expect(screen.getByTestId("interjection-missing")).toHaveTextContent(
      "Oxagen has not recorded this question yet. Re-read the run in a moment.",
    );
    expect(screen.queryByTestId("interjection-send")).toBeNull();
    expect(screen.queryByTestId("interjection-repository")).toBeNull();
    await expectNoAxe(container);
  });

  it("names the permission when the read is denied (negative)", async () => {
    const { container } = await renderHeld({
      interjections: { ok: false, reason: "denied", permission: "run.read" },
    });
    const failure = screen
      .getByTestId("interjection-question")
      .querySelector("[data-reason]");
    expect(failure).toHaveAttribute("data-reason", "denied");
    expect(failure).toHaveTextContent(
      "You cannot see Operator question in this workspace. Your roles do not include run.read",
    );
    expect(screen.queryByTestId("interjection-send")).toBeNull();
    await expectNoAxe(container);
  });

  it("says the read failed when it throws, and the page still draws (negative)", async () => {
    const { container, calls } = await renderHeld({ interjections: "throws" });
    expect(calls.interjections).toHaveLength(1);
    expect(
      screen.getByTestId("interjection-question").querySelector("[data-reason]"),
    ).toHaveAttribute("data-reason", "error");
    expect(screen.getByTestId("interjection-question")).toHaveTextContent(
      "Operator question could not be loaded: the control plane answered frame_store_unreachable.",
    );
    expect(screen.getByTestId("interjection-frames")).toBeInTheDocument();
    await expectNoAxe(container);
  });

  it("says a question with no body has no paths to show (negative)", async () => {
    const { container } = await renderHeld({
      interjections: questions([runInterjection({ body: null })]),
    });
    expect(screen.getByTestId("interjection-no-body")).toHaveTextContent(
      "This question carries no body, so its paths cannot be shown.",
    );
    expect(screen.queryByTestId("interjection-send")).toBeNull();
    expect(screen.queryByTestId("interjection-timeout")).toBeNull();
    await expectNoAxe(container);
  });
});

describe("which runs get this page", () => {
  it("opens the ordinary page on any tab, which reads no questions", async () => {
    const { container, calls } = await renderHeld({ tab: "transcript" });
    expect(screen.queryByTestId("run-interjection")).toBeNull();
    expect(screen.getByTestId("run-status")).toBeInTheDocument();
    expect(calls.interjections).toEqual([]);
    await expectNoAxe(container);
  });

  it("opens the ordinary page for a question raised on a subagent's chain (negative)", async () => {
    const frames = heldFrames().map((frame) =>
      frame.type === "control.interject"
        ? { ...frame, chainRef: "8f1c2d3e-0000-4000-8000-00000000c0de" }
        : frame,
    );
    const { container, calls } = await renderHeld({ detail: held(frames) });
    expect(screen.queryByTestId("run-interjection")).toBeNull();
    expect(calls.interjections).toEqual([]);
    await expectNoAxe(container);
  });
});
