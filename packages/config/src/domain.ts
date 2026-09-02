// ── Org type ──────────────────────────────────────────────────────────────────

export const ORG_TYPE_VALUES = ["personal", "business"] as const;
export type OrgType = (typeof ORG_TYPE_VALUES)[number];

export const ORG_TYPE_OPTIONS: ReadonlyArray<{
  value: OrgType;
  label: string;
  description: string;
}> = [
  {
    value: "personal",
    label: "Personal",
    description: "Just you — personal projects and individual use.",
  },
  {
    value: "business",
    label: "Business",
    description: "A company or team with shared billing and members.",
  },
];

// ── Industry ──────────────────────────────────────────────────────────────────

export const INDUSTRY_VALUES = [
  "software-it",
  "financial-services",
  "healthcare",
  "retail-ecommerce",
  "manufacturing",
  "education",
  "media-entertainment",
  "real-estate",
  "professional-services",
  "marketing-advertising",
  "telecommunications",
  "energy-utilities",
  "transportation-logistics",
  "travel-hospitality",
  "construction",
  "agriculture",
  "government",
  "nonprofit",
  "legal",
  "insurance",
  "automotive",
  "food-beverage",
  "pharmaceuticals",
  "other",
] as const;

export type Industry = (typeof INDUSTRY_VALUES)[number];

export const INDUSTRY_OPTIONS: ReadonlyArray<{
  value: Industry;
  label: string;
}> = [
  { value: "software-it", label: "Software & IT" },
  { value: "financial-services", label: "Financial Services" },
  { value: "healthcare", label: "Healthcare & Life Sciences" },
  { value: "retail-ecommerce", label: "Retail & E-commerce" },
  { value: "manufacturing", label: "Manufacturing" },
  { value: "education", label: "Education" },
  { value: "media-entertainment", label: "Media & Entertainment" },
  { value: "real-estate", label: "Real Estate" },
  { value: "professional-services", label: "Professional Services" },
  { value: "marketing-advertising", label: "Marketing & Advertising" },
  { value: "telecommunications", label: "Telecommunications" },
  { value: "energy-utilities", label: "Energy & Utilities" },
  { value: "transportation-logistics", label: "Transportation & Logistics" },
  { value: "travel-hospitality", label: "Travel & Hospitality" },
  { value: "construction", label: "Construction" },
  { value: "agriculture", label: "Agriculture" },
  { value: "government", label: "Government & Public Sector" },
  { value: "nonprofit", label: "Nonprofit" },
  { value: "legal", label: "Legal" },
  { value: "insurance", label: "Insurance" },
  { value: "automotive", label: "Automotive" },
  { value: "food-beverage", label: "Food & Beverage" },
  { value: "pharmaceuticals", label: "Pharmaceuticals" },
  { value: "other", label: "Other" },
];

// ── Employee size ─────────────────────────────────────────────────────────────

export const EMPLOYEE_SIZE_VALUES = [
  "1",
  "2-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10000+",
] as const;

export type EmployeeSize = (typeof EMPLOYEE_SIZE_VALUES)[number];

export const EMPLOYEE_SIZE_OPTIONS: ReadonlyArray<{
  value: EmployeeSize;
  label: string;
}> = [
  { value: "1", label: "1 (just me)" },
  { value: "2-10", label: "2–10" },
  { value: "11-50", label: "11–50" },
  { value: "51-200", label: "51–200" },
  { value: "201-500", label: "201–500" },
  { value: "501-1000", label: "501–1,000" },
  { value: "1001-5000", label: "1,001–5,000" },
  { value: "5001-10000", label: "5,001–10,000" },
  { value: "10000+", label: "10,000+" },
];
