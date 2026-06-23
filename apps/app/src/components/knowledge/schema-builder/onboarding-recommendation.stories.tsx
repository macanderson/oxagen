import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { OnboardingRecommendation } from "./onboarding-recommendation";

const meta: Meta<typeof OnboardingRecommendation> = {
  title: "Knowledge/SchemaBuilder/OnboardingRecommendation",
  component: OnboardingRecommendation,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof OnboardingRecommendation>;

export const Default: Story = {
  render: () => (
    <OnboardingRecommendation
      slugs={{ orgSlug: "acme", workspaceSlug: "main" }}
      onApply={async (schemaName, labels) => {
        console.log("Apply:", schemaName, labels);
      }}
      onDiscard={() => console.log("Discarded")}
    />
  ),
};
