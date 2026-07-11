//! Model catalog. Binding rule from
//! `docs/specs/oxagen-rust-cli/07-model-matrix.md` §3: **a slug not present
//! in the catalog is a hard, immediate, named error, never a silent
//! fallback** (the TS-era phantom `glm-5.2-turbo` slug and gateway
//! slug-drift lessons, L-M1/L-M2). The seed below covers every provider
//! `crates/oxagen-cli/src/config.rs`'s `PROVIDERS` table can select — the
//! two used to be all that existed, which meant the hard-error rule above
//! was silently unenforced for 5 of 7 configured providers (any of their
//! default models would fail this lookup were it ever wired in). `oxagen
//! models refresh` (a real network call against each provider's `/models`
//! endpoint that grows this catalog with live data) is future work; the
//! shape does not change, only the row count.

use oxagen_protocol::ProviderError;

/// Which tool-call dialect a model's provider speaks
/// (`07-model-matrix.md` §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolDialect {
    AnthropicTools,
    OpenaiJson,
}

/// One catalog row — provider-native slug, verified against the provider's
/// own `/models` endpoint (seed data below is the day-0 offline fallback).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogEntry {
    pub id: &'static str,
    pub provider: &'static str,
    pub family: &'static str,
    pub context_window: u32,
    pub tool_dialect: ToolDialect,
}

/// The in-binary seed catalog. Curated, versioned data — not code that
/// call sites reach past. `Catalog::resolve` is the only sanctioned way to
/// turn a user-supplied slug into a usable model reference.
pub struct Catalog {
    entries: Vec<CatalogEntry>,
}

impl Catalog {
    /// The in-binary seed: one row per provider `config.rs::PROVIDERS` can
    /// select, keyed to that table's `default_model`. `oxagen models
    /// refresh` (future work) grows this with live `/models` data; the
    /// shape does not change, only the row count.
    pub fn seed() -> Self {
        Self {
            entries: vec![
                CatalogEntry {
                    id: "glm-5.2",
                    provider: "zai",
                    family: "glm",
                    context_window: 200_000,
                    tool_dialect: ToolDialect::OpenaiJson,
                },
                CatalogEntry {
                    id: "claude-fable-5",
                    provider: "anthropic",
                    family: "claude",
                    context_window: 200_000,
                    tool_dialect: ToolDialect::AnthropicTools,
                },
                CatalogEntry {
                    id: "gpt-5.5",
                    provider: "openai",
                    family: "gpt",
                    context_window: 400_000,
                    tool_dialect: ToolDialect::OpenaiJson,
                },
                CatalogEntry {
                    id: "grok-4",
                    provider: "xai",
                    family: "grok",
                    context_window: 256_000,
                    tool_dialect: ToolDialect::OpenaiJson,
                },
                CatalogEntry {
                    id: "deepseek-chat",
                    provider: "deepseek",
                    family: "deepseek",
                    context_window: 128_000,
                    tool_dialect: ToolDialect::OpenaiJson,
                },
                CatalogEntry {
                    id: "gemini-3-pro",
                    provider: "gemini",
                    family: "gemini",
                    context_window: 1_000_000,
                    // Routed through Google's OpenAI-compatibility shim
                    // today (config.rs base_url has the `/openai` suffix);
                    // a native Gemini adapter would use its own
                    // GeminiFunctions dialect once built (deferred — see
                    // config.rs and the Phase 2 PR description).
                    tool_dialect: ToolDialect::OpenaiJson,
                },
                CatalogEntry {
                    id: "auto",
                    provider: "openrouter",
                    family: "openrouter",
                    // OpenRouter's own meta-routing model — a real,
                    // provider-native catalog entry, not our internal
                    // `Option<ModelRef>` "auto" sentinel (L-M3 is about
                    // OUR resolver never using a string for "no pin"; this
                    // is a third party's own product feature we pass
                    // through verbatim).
                    context_window: 128_000,
                    tool_dialect: ToolDialect::OpenaiJson,
                },
            ],
        }
    }

    /// Resolve a slug against the catalog. Returns `ProviderError::UnknownModel`
    /// (never a fallback to a default model) when the slug isn't present —
    /// the loud, named error the spec requires.
    pub fn resolve(&self, slug: &str) -> Result<&CatalogEntry, ProviderError> {
        self.entries
            .iter()
            .find(|entry| entry.id == slug)
            .ok_or_else(|| ProviderError::UnknownModel {
                slug: slug.to_string(),
            })
    }

    pub fn entries(&self) -> &[CatalogEntry] {
        &self.entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_known_slug_succeeds() {
        let catalog = Catalog::seed();
        let entry = catalog.resolve("glm-5.2").expect("glm-5.2 is seeded");
        assert_eq!(entry.provider, "zai");
        assert_eq!(entry.tool_dialect, ToolDialect::OpenaiJson);
    }

    #[test]
    fn resolve_unknown_slug_is_a_named_hard_error_never_a_fallback() {
        let catalog = Catalog::seed();
        let err = catalog.resolve("glm-5.2-turbo").unwrap_err();
        match err {
            ProviderError::UnknownModel { slug } => assert_eq!(slug, "glm-5.2-turbo"),
            other => panic!("expected UnknownModel, got {other:?}"),
        }
    }

    #[test]
    fn seed_catalog_has_no_duplicate_ids() {
        let catalog = Catalog::seed();
        let mut ids: Vec<&str> = catalog.entries().iter().map(|e| e.id).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(
            ids.len(),
            before,
            "catalog seed must not contain duplicate slugs"
        );
    }

    #[test]
    fn seed_covers_every_provider_oxagen_cli_can_select() {
        // oxagen-cli/src/config.rs::PROVIDERS lists 7 providers; this test
        // doesn't import that crate (oxagen-cli depends on oxagen-model,
        // not the reverse) but pins the provider id set here so the two
        // can't silently drift apart again — the actual cross-check lives
        // in oxagen-cli's own test suite (config::tests).
        let catalog = Catalog::seed();
        for provider in [
            "zai",
            "anthropic",
            "openai",
            "xai",
            "deepseek",
            "gemini",
            "openrouter",
        ] {
            assert!(
                catalog.entries().iter().any(|e| e.provider == provider),
                "no catalog entry for provider `{provider}`"
            );
        }
    }
}
