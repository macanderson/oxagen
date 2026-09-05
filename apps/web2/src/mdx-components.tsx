import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { IllustrationAgent } from "@/components/illustrations/illustration-agent";
import { IllustrationApi } from "@/components/illustrations/illustration-api";
import { IllustrationByokSpot } from "@/components/illustrations/illustration-byok-spot";
import { IllustrationCli } from "@/components/illustrations/illustration-cli";
import { IllustrationCliInstallSpot } from "@/components/illustrations/illustration-cli-install-spot";
import { IllustrationConfiguration } from "@/components/illustrations/illustration-configuration";
import { IllustrationConnectionSpot } from "@/components/illustrations/illustration-connection-spot";
import { IllustrationEnterprise } from "@/components/illustrations/illustration-enterprise";
import { IllustrationGettingStarted } from "@/components/illustrations/illustration-getting-started";
import { IllustrationGovernance } from "@/components/illustrations/illustration-governance";
import { IllustrationMcp } from "@/components/illustrations/illustration-mcp";
import { IllustrationOverview } from "@/components/illustrations/illustration-overview";
import { IllustrationPlugins } from "@/components/illustrations/illustration-plugins";
import { IllustrationPrivacySpot } from "@/components/illustrations/illustration-privacy-spot";
import { IllustrationRbacSpot } from "@/components/illustrations/illustration-rbac-spot";
import { IllustrationSecurity } from "@/components/illustrations/illustration-security";
import { IllustrationSkillSpot } from "@/components/illustrations/illustration-skill-spot";
import { Mermaid } from "@/components/mdx/mermaid";
import { TuiGraphSearch } from "@/components/tui/tui-graph-search";
import { TuiInteractiveAnswer } from "@/components/tui/tui-interactive-answer";
import { TuiLogin } from "@/components/tui/tui-login";
import { TuiReplBanner } from "@/components/tui/tui-repl-banner";
import { TuiSettingsShow } from "@/components/tui/tui-settings-show";
import { TuiSlashMenu } from "@/components/tui/tui-slash-menu";

// Stella's docs component set — cards, provider grid, deck screenshots, and
// the Command Deck tab explorer are ported structurally (see
// src/components/stella/*); the ~20 bespoke inline-SVG diagrams are not (see
// diagram-placeholder.tsx's header comment for why) and render as labelled
// text panels carrying the same one-sentence description instead.
import {
  Badge,
  CardGrid,
  OptionCard,
  SpecCard,
  ToolCard,
} from "@/components/stella/cards";
import { CommandDeckExplorer } from "@/components/stella/command-deck-explorer";
import { DeckShot } from "@/components/stella/deck-shot";
import {
  BudgetGuardDiagram,
  ClaimLockDiagram,
  CostChainDiagram,
  CredentialChainDiagram,
  EngineGateDiagram,
  EngineOwnershipDiagram,
  EnginePathsDiagram,
  EngineSequenceDiagram,
  EngineTestHarnessDiagram,
  EventContractDiagram,
  FleetFanoutDiagram,
  HeroFlowDiagram,
  HookLifecycleDiagram,
  LoopVerdictDiagram,
  McpTopologyDiagram,
  PermissionGateDiagram,
  QuickstartDiagram,
  RecallLoopDiagram,
  SettingsCascadeDiagram,
  SingleThreadDiagram,
  TelemetryFlowDiagram,
} from "@/components/stella/diagram-placeholder";
import { ProviderGrid } from "@/components/stella/provider-cards";
import { ProviderLogo, ProviderMark } from "@/components/stella/provider-logos";

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    IllustrationAgent,
    IllustrationApi,
    IllustrationByokSpot,
    IllustrationCli,
    IllustrationCliInstallSpot,
    IllustrationConfiguration,
    IllustrationConnectionSpot,
    IllustrationEnterprise,
    IllustrationGettingStarted,
    IllustrationGovernance,
    IllustrationMcp,
    IllustrationOverview,
    IllustrationPlugins,
    IllustrationPrivacySpot,
    IllustrationRbacSpot,
    IllustrationSecurity,
    IllustrationSkillSpot,
    Mermaid,
    TuiGraphSearch,
    TuiInteractiveAnswer,
    TuiLogin,
    TuiReplBanner,
    TuiSettingsShow,
    TuiSlashMenu,
    // Stella docs
    Badge,
    CardGrid,
    OptionCard,
    SpecCard,
    ToolCard,
    CommandDeckExplorer,
    DeckShot,
    ProviderGrid,
    ProviderLogo,
    ProviderMark,
    HeroFlowDiagram,
    RecallLoopDiagram,
    FleetFanoutDiagram,
    QuickstartDiagram,
    CredentialChainDiagram,
    SettingsCascadeDiagram,
    PermissionGateDiagram,
    TelemetryFlowDiagram,
    EnginePathsDiagram,
    EngineOwnershipDiagram,
    EngineTestHarnessDiagram,
    EngineGateDiagram,
    EngineSequenceDiagram,
    LoopVerdictDiagram,
    McpTopologyDiagram,
    HookLifecycleDiagram,
    SingleThreadDiagram,
    EventContractDiagram,
    BudgetGuardDiagram,
    CostChainDiagram,
    ClaimLockDiagram,
    ...components,
  };
}
