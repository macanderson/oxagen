/**
 * built-in-templates.ts — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Source of truth: templates/*.yaml
 * Regenerate:      pnpm --filter app generate:templates
 *
 * Statically bundled so the prompt-template registry is browser-safe (no
 * runtime fs reads). Validated against promptTemplateSchema at registry load.
 */
import type { PromptTemplateInput } from "./schema";

export const BUILT_IN_TEMPLATES: PromptTemplateInput[] = [
  {
    id: "connect-data-source",
    title: "Connect a data source",
    description:
      "Walk me through connecting a new data source to this workspace's knowledge graph.",
    category: "configure",
    tags: ["connector", "knowledge", "ingestion", "setup"],
    applicableTo: [
      {
        routePattern: "/{org}/{ws}/knowledge/sources",
      },
      {
        routePattern: "/{org}/{ws}/knowledge",
      },
    ],
    autoSubmit: false,
    variables: [],
    body: "Help me connect a new data source to this workspace. Walk me through choosing the right\nconnector, configuring credentials, and setting up the initial sync schedule.\nShow me what data will flow into the knowledge graph.\n",
  },
  {
    id: "create-trigger-for-event",
    title: "Create trigger for this event",
    description:
      "Create a new automation trigger that fires when this event type occurs.",
    category: "create",
    tags: ["trigger", "automation", "event"],
    applicableTo: [
      {
        routePattern: "/{org}/{ws}/automation/events/:eventId",
      },
    ],
    autoSubmit: false,
    shortcut: "⌘+E",
    variables: [
      {
        name: "event_id",
        resolver: "param",
        source: "params.eventId",
        required: true,
      },
    ],
    body: "Create a new automation trigger for event {{event_id}}. Help me configure the trigger conditions,\nfilter criteria, and the action to perform when this event fires.\n",
  },
  {
    id: "explain-audit-event",
    title: "Explain this audit event",
    description:
      "Plain-English explanation of what happened in this audit event and why it matters.",
    category: "investigate",
    tags: ["audit", "security", "compliance", "explain"],
    applicableTo: [
      {
        routePattern: "/{org}/{ws}/activity/audit/:eventId",
      },
      {
        routePattern: "/{org}/audit/:eventId",
      },
    ],
    capability: "activity.audit.read",
    autoSubmit: true,
    variables: [
      {
        name: "event_id",
        resolver: "param",
        source: "params.eventId",
        required: true,
      },
    ],
    body: "Explain audit event {{event_id}} in plain English. What action was performed, who performed it,\nwhat was changed, and what are the compliance or security implications of this event?\n",
  },
  {
    id: "invite-teammate",
    title: "Invite a teammate",
    description:
      "Invite a new member to this organization and assign them the right role.",
    category: "communicate",
    tags: ["invite", "members", "team", "access"],
    applicableTo: [
      {
        routePattern: "/{org}/members",
      },
      {
        routePattern: "/{org}/settings/members",
      },
    ],
    capability: "org.member.invite",
    autoSubmit: false,
    variables: [],
    body: "I need to invite a teammate to this organization. Help me fill in the invite form:\nsuggest the right role for a developer/analyst/admin and explain what permissions each role grants.\n",
  },
  {
    id: "open-source-playbook",
    title: "Open source playbook in editor",
    description:
      "Navigate to the playbook editor for the playbook that spawned this run.",
    category: "configure",
    tags: ["playbook", "editor", "navigate", "run"],
    applicableTo: [
      {
        routePattern: "/{org}/{ws}/activity/runs/:runId",
      },
    ],
    capability: "activity.run.read",
    autoSubmit: false,
    variables: [
      {
        name: "run_id",
        resolver: "param",
        source: "params.runId",
        required: true,
      },
    ],
    body: "Find the playbook that spawned run {{run_id}} and show me a link to open it in the\nWorkbench editor so I can review or modify its definition.\n",
  },
  {
    id: "run-this-playbook",
    title: "Run this playbook",
    description:
      "Start a new run of this playbook, filling in required parameters.",
    category: "create",
    tags: ["playbook", "run", "execute"],
    applicableTo: [
      {
        routePattern: "/{org}/{ws}/workbench/playbooks/:playbookId",
      },
    ],
    capability: "playbook.run.create",
    autoSubmit: false,
    variables: [
      {
        name: "playbook_id",
        resolver: "param",
        source: "params.playbookId",
        required: true,
      },
      {
        name: "playbook_name",
        resolver: "page",
        source: "page.entity.label",
        required: false,
      },
    ],
    body: "I want to run playbook {{playbook_name}} ({{playbook_id}}). Help me fill in the required\nparameters for this run. Show me what each parameter does and suggest sensible defaults\nbased on recent runs.\n",
  },
  {
    id: "show-similar-failed-runs",
    title: "Show similar failed runs",
    description:
      "Find other runs that hit the same error as this one, across all playbooks.",
    category: "investigate",
    tags: ["run", "failure", "similarity", "debug"],
    applicableTo: [
      {
        routePattern: "/{org}/{ws}/activity/runs/:runId",
      },
    ],
    capability: "activity.run.read",
    autoSubmit: true,
    variables: [
      {
        name: "run_id",
        resolver: "param",
        source: "params.runId",
        required: true,
      },
    ],
    body: "Show me other runs in this workspace that failed with the same error as run {{run_id}}.\nGroup by playbook and error type. For each group, show the failure rate over the last 7 days\nand the most recent occurrence.\n",
  },
  {
    id: "summarize-run-failure",
    title: "Summarize this run's failure",
    description:
      "Generate a root-cause summary for a failed run, including the failing step and most likely cause.",
    category: "investigate",
    tags: ["run", "failure", "summary", "debug"],
    applicableTo: [
      {
        routePattern: "/{org}/{ws}/agents/runs/:runId",
      },
    ],
    capability: "debug_execution",
    autoSubmit: true,
    variables: [
      {
        name: "run_id",
        resolver: "param",
        source: "params.runId",
        required: true,
      },
    ],
    body: "Diagnose the failure of run {{run_id}} using debug_execution with\nsummarize:true. Report the failing step, the error class and message, the\nranked suspect files, and the root-cause diagnosis. Format as:\nProblem → Root Cause → Recommended Fix.\n",
  },
  {
    id: "summarize-workspace-activity",
    title: "Summarize this workspace's recent activity",
    description:
      "A digest of what happened in this workspace over the past 24 hours.",
    category: "analyze",
    tags: ["workspace", "activity", "summary", "digest"],
    applicableTo: [
      {
        routePattern: "/{org}/{ws}",
      },
      {
        routePattern: "/{org}/{ws}/ask",
      },
    ],
    autoSubmit: true,
    variables: [],
    body: "Give me a digest of this workspace's activity in the past 24 hours. Include:\n- Runs completed (successful and failed)\n- Triggers that fired\n- Automation changes made\n- Any alerts or anomalies worth my attention\nHighlight anything that needs action from me.\n",
  },
  {
    id: "why-is-trigger-failing",
    title: "Why is this trigger failing?",
    description:
      "Diagnose why this trigger is not firing successfully and suggest fixes.",
    category: "investigate",
    tags: ["trigger", "failure", "debug", "automation"],
    applicableTo: [
      {
        routePattern: "/{org}/{ws}/automation/triggers/:triggerId",
      },
    ],
    capability: "trigger.read",
    autoSubmit: true,
    variables: [
      {
        name: "trigger_id",
        resolver: "param",
        source: "params.triggerId",
        required: true,
      },
      {
        name: "trigger_name",
        resolver: "page",
        source: "page.entity.label",
        required: false,
      },
    ],
    body: "Diagnose why trigger {{trigger_name}} ({{trigger_id}}) is failing. Look at the recent\nexecution history, error logs, and configuration. Explain the root cause and suggest\nthe most likely fix. If it's a configuration issue, show me what to change.\n",
  },
];
