//! Configuration: provider/model resolution, BYOK credential lookup.
//!
//! Resolution order per 01-product-spec.md §4: CLI flag -> env var ->
//! config file (TOML, future) -> interactive prompt (future).
//!
//! Phase 0/1 implements the env-var step. The user sets one or more of:
//!   ZAI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY,
//!   DEEPSEEK_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY
//! ...and stella picks the first available provider, or uses --model to pin.

use std::env;

use colored::Colorize;

/// One provider's config: id, env var name, display name, default model.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub id: &'static str,
    pub env_var: &'static str,
    pub display_name: &'static str,
    pub default_model: &'static str,
    pub base_url: &'static str,
    /// Whether this provider speaks the OpenAI-compatible chat/completions
    /// dialect (true for Z.ai, OpenAI, xAI, DeepSeek, OpenRouter, any
    /// OpenAI-compatible gateway). False for Anthropic (Messages API).
    pub openai_compatible: bool,
}

/// All supported providers, in preference order.
pub static PROVIDERS: &[ProviderConfig] = &[
    ProviderConfig {
        id: "zai",
        env_var: "ZAI_API_KEY",
        display_name: "Z.ai (GLM 5.2)",
        default_model: "glm-5.2",
        base_url: "https://api.z.ai/api/paas/v4",
        openai_compatible: true,
    },
    ProviderConfig {
        id: "anthropic",
        env_var: "ANTHROPIC_API_KEY",
        display_name: "Anthropic (Claude)",
        default_model: "claude-fable-5",
        base_url: "https://api.anthropic.com",
        openai_compatible: false,
    },
    ProviderConfig {
        id: "openai",
        env_var: "OPENAI_API_KEY",
        display_name: "OpenAI (GPT)",
        default_model: "gpt-5.5",
        base_url: "https://api.openai.com/v1",
        openai_compatible: true,
    },
    ProviderConfig {
        id: "xai",
        env_var: "XAI_API_KEY",
        display_name: "xAI (Grok)",
        default_model: "grok-4",
        base_url: "https://api.x.ai/v1",
        openai_compatible: true,
    },
    ProviderConfig {
        id: "deepseek",
        env_var: "DEEPSEEK_API_KEY",
        display_name: "DeepSeek",
        default_model: "deepseek-chat",
        base_url: "https://api.deepseek.com/v1",
        openai_compatible: true,
    },
    ProviderConfig {
        id: "gemini",
        env_var: "GEMINI_API_KEY",
        display_name: "Google Gemini",
        default_model: "gemini-3-pro",
        // NOTE: this is Google's OpenAI-compatibility shim
        // (`/v1beta/openai/...`), not Gemini's native `generateContent`
        // wire shape — the two are NOT interchangeable and the base URL
        // must include the `/openai` segment or every request 404s. A
        // native "Gemini direct" adapter (07-model-matrix.md §2: thinking
        // support, Imagen/Veo, native multimodal) is real follow-up work,
        // deferred because it can't be verified without a live
        // GEMINI_API_KEY in this environment (same reasoning as Bedrock/
        // Vertex/local-GGUF — see the Phase 2 PR description).
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        openai_compatible: true,
    },
    ProviderConfig {
        id: "openrouter",
        env_var: "OPENROUTER_API_KEY",
        display_name: "OpenRouter",
        default_model: "auto",
        base_url: "https://openrouter.ai/api/v1",
        openai_compatible: true,
    },
];

/// Resolved configuration: which provider, which model, which API key.
#[derive(Debug, Clone)]
pub struct Config {
    pub provider: ProviderConfig,
    pub model_id: String,
    pub api_key: String,
    pub workspace_root: std::path::PathBuf,
}

impl Config {
    /// Load config: resolve provider from --model flag or first available
    /// key in env. Errors if no key is found at all.
    pub fn load(model_override: Option<&str>) -> Result<Self, String> {
        let workspace_root =
            env::current_dir().map_err(|e| format!("cannot determine workspace root: {e}"))?;

        // If --model provider/model_id was given, resolve that provider.
        if let Some(model_spec) = model_override {
            let (provider_id, model_id) = match model_spec.split_once('/') {
                Some((p, m)) => (p, m.to_string()),
                None => {
                    // Just a model slug — find which provider has it.
                    let provider = PROVIDERS
                        .iter()
                        .find(|p| p.default_model == model_spec)
                        .ok_or_else(|| {
                            format!(
                                "model `{model_spec}` not recognized — use provider/model_id format (e.g. zai/glm-5.2)\navailable providers: {}",
                                { let v: Vec<&str> = PROVIDERS.iter().map(|p| p.id).collect(); v.join(", ") }
                            )
                        })?;
                    return Self::resolve(provider, model_id_override(model_spec), &workspace_root);
                }
            };

            let provider = PROVIDERS
                .iter()
                .find(|p| p.id == provider_id)
                .ok_or_else(|| {
                    format!("unknown provider `{provider_id}` — available: {}", {
                        let v: Vec<&str> = PROVIDERS.iter().map(|p| p.id).collect();
                        v.join(", ")
                    })
                })?;

            return Self::resolve(provider, model_id, &workspace_root);
        }

        // No --model: pick first provider with a key in env.
        for provider in PROVIDERS {
            if let Ok(key) = env::var(provider.env_var)
                && !key.is_empty()
            {
                return Self::resolve(
                    provider,
                    provider.default_model.to_string(),
                    &workspace_root,
                );
            }
        }

        Err(format!(
            "no API key found. Set one of: {}\n\nExample: export ZAI_API_KEY=your_key_here",
            PROVIDERS
                .iter()
                .map(|p| format!("{} ({})", p.env_var, p.display_name))
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }

    fn resolve(
        provider: &ProviderConfig,
        model_id: String,
        workspace_root: &std::path::Path,
    ) -> Result<Self, String> {
        let api_key = env::var(provider.env_var).map_err(|_| {
            format!(
                "{} is not set — set it to use {} as the model provider",
                provider.env_var, provider.display_name
            )
        })?;
        if api_key.is_empty() {
            return Err(format!("{} is set but empty", provider.env_var));
        }

        Ok(Self {
            provider: provider.clone(),
            model_id,
            api_key,
            workspace_root: workspace_root.to_path_buf(),
        })
    }

    pub fn print_models(&self) {
        println!(
            "{}\n",
            "Stella — Available Providers & Models".cyan().bold()
        );
        for p in PROVIDERS {
            let key_status = if env::var(p.env_var).map(|v| !v.is_empty()).unwrap_or(false) {
                "✓ configured".green()
            } else {
                "✗ no key".dimmed()
            };
            println!(
                "  {} {}/{}  {}  [{}]",
                key_status,
                p.id.bright_blue(),
                p.default_model.bright_white(),
                p.display_name,
                p.base_url.dimmed(),
            );
        }
        println!("\n  Use --model provider/model_id to pin a specific model.");
        println!("  Example: stella --model zai/glm-5.2 run 'fix the failing test'");
    }

    pub fn print_config(&self) {
        println!("{}\n", "Stella — Current Configuration".cyan().bold());
        println!("  Provider:   {}", self.provider.display_name.bright_blue());
        println!(
            "  Model:      {}/{}",
            self.provider.id.bright_blue(),
            self.model_id.bright_white()
        );
        println!(
            "  API Key:    {}",
            format!(
                "{}...{}",
                &self.api_key[..8],
                &self.api_key[self.api_key.len().saturating_sub(4)..]
            )
            .dimmed()
        );
        println!("  Base URL:   {}", self.provider.base_url.dimmed());
        println!("  Workspace:  {}", self.workspace_root.display());
        println!(
            "  Dialect:    {}",
            if self.provider.openai_compatible {
                "OpenAI-compatible"
            } else {
                "Anthropic Messages"
            }
        );
    }
}

impl Config {
    /// Print all available providers/models without needing a resolved config.
    pub fn print_available_models() {
        println!(
            "{}\n",
            "Stella — Available Providers & Models".cyan().bold()
        );
        for p in PROVIDERS {
            let key_status = if env::var(p.env_var).map(|v| !v.is_empty()).unwrap_or(false) {
                "✓ configured".green()
            } else {
                "✗ no key".dimmed()
            };
            println!(
                "  {} {}/{}  {}  [{}]",
                key_status,
                p.id.bright_blue(),
                p.default_model.bright_white(),
                p.display_name,
                p.base_url.dimmed(),
            );
        }
        println!("\n  Use --model provider/model_id to pin a specific model.");
        println!("  Example: stella --model zai/glm-5.2 run 'fix the failing test'");
    }
}

fn model_id_override(slug: &str) -> String {
    slug.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for the bug fixed alongside this test: every
    /// provider's `default_model` here must resolve against
    /// `oxagen_model::catalog::Catalog::seed()`, or `build_provider`'s
    /// catalog check (`agent.rs`) would hard-error on first use of a
    /// provider whose default was never added to the seed — exactly what
    /// happened for 5 of these 7 rows before the catalog was completed.
    #[test]
    fn every_provider_default_model_resolves_against_the_catalog_seed() {
        let catalog = oxagen_model::catalog::Catalog::seed();
        for provider in PROVIDERS {
            catalog.resolve(provider.default_model).unwrap_or_else(|e| {
                panic!(
                    "provider `{}`'s default_model `{}` is not in the catalog seed: {e}",
                    provider.id, provider.default_model
                )
            });
        }
    }

    #[test]
    fn provider_ids_are_unique() {
        let mut ids: Vec<&str> = PROVIDERS.iter().map(|p| p.id).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "duplicate provider id in PROVIDERS");
    }
}
