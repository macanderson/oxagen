/**
 * Configure Form Component
 *
 * Advanced configuration options for benchmark runs.
 */

"use client";

import { useState } from "react";

interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface SelectField {
  id: string;
  label: string;
  type: "select";
  options: SelectOption[];
  default: string;
  description?: string;
}

interface NumberField {
  id: string;
  label: string;
  type: "number";
  default: number;
  min?: number;
  max?: number;
  description?: string;
}

interface BooleanField {
  id: string;
  label: string;
  type: "boolean";
  default: boolean;
  description?: string;
}

interface GroupField {
  id: string;
  label: string;
  type: "group";
  fields: NumberField[];
  description?: string;
}

type ConfigField = SelectField | NumberField | BooleanField | GroupField;

interface ConfigSection {
  title: string;
  description: string;
  fields: ConfigField[];
}

const CONFIG_OPTIONS: Record<string, ConfigSection> = {
  execution: {
    title: "🚀 Execution",
    description: "How the benchmark is executed",
    fields: [
      {
        id: "mode",
        label: "Execution Mode",
        type: "select",
        options: [
          { value: "sequential", label: "Sequential (one at a time)", description: "Run tasks one after another" },
          { value: "parallel", label: "Parallel (multiple at once)", description: "Run multiple tasks concurrently" },
          { value: "adaptive", label: "Adaptive", description: "Adjust concurrency based on system resources" }
        ],
        default: "sequential"
      },
      {
        id: "maxRetries",
        label: "Max Retries per Task",
        type: "number",
        default: 0,
        min: 0,
        max: 5,
        description: "Number of retry attempts for failed tasks"
      },
      {
        id: "continueOnError",
        label: "Continue on Error",
        type: "boolean",
        default: true,
        description: "Continue benchmark even if individual tasks fail"
      },
      {
        id: "saveIntermediate",
        label: "Save Intermediate Results",
        type: "boolean",
        default: true,
        description: "Save results after each task completes"
      }
    ]
  },
  environment: {
    title: "🌍 Environment",
    description: "Agent execution environment settings",
    fields: [
      {
        id: "sandbox",
        label: "Sandbox Type",
        type: "select",
        options: [
          { value: "docker", label: "Docker", description: "Isolated Docker containers" },
          { value: "modal", label: "Modal Runner", description: "Modal ephemeral sandboxes" },
          { value: "local", label: "Local", description: "Run on local machine (use with caution)" }
        ],
        default: "docker"
      },
      {
        id: "resourceLimits",
        label: "Resource Limits",
        type: "group",
        fields: [
          { id: "memory", label: "Memory (MB)", type: "number", default: 2048, min: 512, max: 16384 },
          { id: "cpu", label: "CPU Cores", type: "number", default: 2, min: 1, max: 16 }
        ]
      },
      {
        id: "networkAccess",
        label: "Allow Network Access",
        type: "boolean",
        default: true,
        description: "Allow agents to access the internet during execution"
      }
    ]
  },
  reporting: {
    title: "📊 Reporting",
    description: "How results are collected and reported",
    fields: [
      {
        id: "reportFormat",
        label: "Report Format",
        type: "select",
        options: [
          { value: "html", label: "HTML Report", description: "Rich HTML report with charts" },
          { value: "json", label: "JSON Data", description: "Raw JSON for programmatic access" },
          { value: "both", label: "Both Formats", description: "Generate both HTML and JSON" }
        ],
        default: "both"
      },
      {
        id: "includeDiffs",
        label: "Include Git Diffs",
        type: "boolean",
        default: true,
        description: "Include full git diffs in results"
      },
      {
        id: "includeTraces",
        label: "Include Agent Traces",
        type: "boolean",
        default: false,
        description: "Include detailed agent execution traces (large files)"
      },
      {
        id: "generateCharts",
        label: "Generate Charts",
        type: "boolean",
        default: true,
        description: "Generate comparison charts and visualizations"
      }
    ]
  },
  validation: {
    title: "✅ Validation",
    description: "Result validation and testing",
    fields: [
      {
        id: "runTests",
        label: "Run Test Suite",
        type: "boolean",
        default: true,
        description: "Automatically run test commands after each task"
      },
      {
        id: "testTimeout",
        label: "Test Timeout (seconds)",
        type: "number",
        default: 120,
        min: 30,
        max: 600,
        description: "Maximum time to wait for tests to complete"
      },
      {
        id: "strictMode",
        label: "Strict Validation",
        type: "boolean",
        default: false,
        description: "Treat warnings as failures (all criteria must pass)"
      },
      {
        id: "verifyOutput",
        label: "Verify Output Compilation",
        type: "boolean",
        default: true,
        description: "Check that modified code compiles before running tests"
      }
    ]
  }
};

export function ConfigureForm() {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);

  const updateConfig = (key: string, value: unknown) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const saveConfig = () => {
    // In real implementation, save to localStorage or API
    localStorage.setItem("arena-config", JSON.stringify(config));
    setSaved(true);
    setTimeout(() => {
      setSaved(false);
    }, 2000);
  };

  const resetConfig = () => {
    setConfig({});
    localStorage.removeItem("arena-config");
  };

  const loadConfig = () => {
    const saved = localStorage.getItem("arena-config");
    if (saved) {
      setConfig(JSON.parse(saved) as Record<string, unknown>);
    }
  };

  return (
    <div className="space-y-8">
      {/* Action Bar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Configure advanced options for your benchmark runs.
        </p>
        <div className="flex gap-2">
          <button
            onClick={resetConfig}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-muted"
          >
            Reset
          </button>
          <button
            onClick={loadConfig}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-muted"
          >
            Load
          </button>
          <button
            onClick={saveConfig}
            className={`px-4 py-2 text-sm rounded-lg font-medium transition-colors ${
              saved
                ? "bg-green-600 text-white"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            }`}
          >
            {saved ? "✓ Saved" : "Save Config"}
          </button>
        </div>
      </div>

      {/* Configuration Sections */}
      {Object.entries(CONFIG_OPTIONS).map(([sectionId, section]) => (
        <section key={sectionId} className="border rounded-xl p-6 space-y-6">
          <div>
            <h2 className="text-xl font-semibold">{section.title}</h2>
            <p className="text-sm text-muted-foreground">{section.description}</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {section.fields.map(field => (
              <FieldComponent
                key={field.id}
                field={field}
                value={config[field.id]}
                onChange={(value) => {
                  updateConfig(field.id, value);
                }}
              />
            ))}
          </div>
        </section>
      ))}

      {/* Export/Import */}
      <section className="border rounded-xl p-6 space-y-4">
        <h2 className="text-xl font-semibold">📦 Export/Import Config</h2>
        <p className="text-sm text-muted-foreground">
          Share your configuration with others or save it for later use.
        </p>

        <div className="flex gap-4">
          <button
            onClick={() => {
              const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `arena-config-${Date.now()}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90"
          >
            Export JSON
          </button>

          <button
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "application/json";
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onload = (e) => {
                    try {
                      const imported = JSON.parse(
                        e.target?.result as string,
                      ) as Record<string, unknown>;
                      setConfig(imported);
                    } catch {
                      alert("Invalid config file");
                    }
                  };
                  reader.readAsText(file);
                }
              };
              input.click();
            }}
            className="px-4 py-2 border rounded-lg hover:bg-muted"
          >
            Import JSON
          </button>
        </div>
      </section>
    </div>
  );
}

function FieldComponent({
  field,
  value,
  onChange
}: {
  field: ConfigField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "select") {
    return (
      <div className="space-y-2">
        <label className="block text-sm font-medium">{field.label}</label>
        <select
          value={(value as string | undefined) ?? field.default}
          onChange={e => { onChange(e.target.value); }}
          className="w-full px-3 py-2 border rounded-lg bg-background"
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {field.description && (
          <p className="text-xs text-muted-foreground">{field.description}</p>
        )}
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id={field.id}
            checked={(value as boolean | undefined) ?? field.default}
            onChange={e => { onChange(e.target.checked); }}
            className="w-5 h-5 text-primary"
          />
          <label htmlFor={field.id} className="text-sm font-medium cursor-pointer">
            {field.label}
          </label>
        </div>
        {field.description && (
          <p className="text-xs text-muted-foreground ml-8">{field.description}</p>
        )}
      </div>
    );
  }

  if (field.type === "number") {
    return (
      <div className="space-y-2">
        <label className="block text-sm font-medium">{field.label}</label>
        <input
          type="number"
          value={(value as number | undefined) ?? field.default}
          onChange={e => { onChange(parseFloat(e.target.value) || 0); }}
          min={field.min}
          max={field.max}
          className="w-full px-3 py-2 border rounded-lg bg-background"
        />
        {field.description && (
          <p className="text-xs text-muted-foreground">{field.description}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">{field.label}</label>
      <input
        type="text"
        value={(value as string | undefined) ?? ""}
        onChange={e => { onChange(e.target.value); }}
        className="w-full px-3 py-2 border rounded-lg bg-background"
      />
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
    </div>
  );
}
