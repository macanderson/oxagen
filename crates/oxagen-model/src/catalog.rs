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
    /// OpenAI's own Responses API (`oxagen_model::openai::OpenAiProvider`).
    /// Structurally distinct from `OpenaiJson` (Chat Completions and every
    /// OpenAI-*compatible* gateway: Z.ai, xAI, DeepSeek, OpenRouter, local)
    /// despite the name overlap: item-based `input`/`output` arrays with
    /// `function_call`/`function_call_output` items, not a `messages` array
    /// with an accumulating `tool_calls` delta array. Real OpenAI models
    /// (the `gpt-5.5` row below) get this variant now that the real
    /// adapter exists; `OpenaiJson` stays the dialect name for everything
    /// that actually speaks the Chat Completions wire shape.
    OpenaiResponses,
    /// Google's native `generateContent` dialect
    /// (`oxagen_model::gemini::GeminiProvider` and
    /// `oxagen_model::vertex::VertexProvider` — identical wire shape,
    /// different auth/addressing): `functionCall`/`functionResponse` parts
    /// correlated by function *name* (no wire call ids), args arriving as
    /// complete JSON objects rather than streamed string fragments, and
    /// Gemini 3 thought signatures riding on call parts
    /// (`07-model-matrix.md` §4 `gemini-functions`).
    GeminiFunctions,
    /// Amazon Bedrock's Converse dialect
    /// (`oxagen_model::bedrock::BedrockProvider`): `toolUse`/`toolResult`
    /// content blocks correlated by `toolUseId`, tool results framed on a
    /// user-role message with an explicit `status` field for failures.
    BedrockConverse,
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
                    // Real adapter now exists (oxagen_model::openai) —
                    // this used to be OpenaiJson, which was wrong: OpenAI
                    // was never routed through Chat Completions, only
                    // through the generic ZaiProvider pointed at OpenAI's
                    // base URL as a stand-in until the Responses API
                    // adapter landed.
                    tool_dialect: ToolDialect::OpenaiResponses,
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
                    // The native Gemini-direct adapter
                    // (oxagen_model::gemini) — this row used to be
                    // OpenaiJson while requests routed through Google's
                    // OpenAI-compatibility shim as a stand-in.
                    tool_dialect: ToolDialect::GeminiFunctions,
                },
                CatalogEntry {
                    // The same Google model surfaced through Vertex AI —
                    // one model genuinely existing on two providers is why
                    // uniqueness (and `resolve_for`) is keyed on
                    // (provider, id), not id alone.
                    id: "gemini-3-pro",
                    provider: "vertex",
                    family: "gemini",
                    context_window: 1_000_000,
                    tool_dialect: ToolDialect::GeminiFunctions,
                },
                CatalogEntry {
                    // A cross-region inference profile, not a bare model id
                    // — Bedrock rejects on-demand invocation of newer
                    // Anthropic models without one.
                    id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
                    provider: "bedrock",
                    family: "claude",
                    context_window: 200_000,
                    tool_dialect: ToolDialect::BedrockConverse,
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
    /// the loud, named error the spec requires. When the same slug exists on
    /// several providers (e.g. `gemini-3-pro` on both `gemini` and
    /// `vertex`), the first row wins; use [`Catalog::resolve_for`] when the
    /// provider is known.
    pub fn resolve(&self, slug: &str) -> Result<&CatalogEntry, ProviderError> {
        self.entries
            .iter()
            .find(|entry| entry.id == slug)
            .ok_or_else(|| ProviderError::UnknownModel {
                slug: slug.to_string(),
            })
    }

    /// Resolve a slug for a specific provider — the form `build_provider`
    /// uses, since the same model genuinely exists on more than one
    /// provider (Gemini on `gemini` and `vertex`; most things on
    /// `openrouter`) and a slug that exists on provider A must still be a
    /// hard error when requested from provider B.
    pub fn resolve_for(&self, provider: &str, slug: &str) -> Result<&CatalogEntry, ProviderError> {
        self.entries
            .iter()
            .find(|entry| entry.provider == provider && entry.id == slug)
            .ok_or_else(|| ProviderError::UnknownModel {
                slug: format!("{provider}/{slug}"),
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
    fn seed_catalog_has_no_duplicate_provider_id_pairs() {
        // Keyed on (provider, id), not id alone: the same model genuinely
        // exists on more than one provider (gemini-3-pro on gemini and
        // vertex), which is exactly why resolve_for exists.
        let catalog = Catalog::seed();
        let mut pairs: Vec<(&str, &str)> = catalog
            .entries()
            .iter()
            .map(|e| (e.provider, e.id))
            .collect();
        let before = pairs.len();
        pairs.sort_unstable();
        pairs.dedup();
        assert_eq!(
            pairs.len(),
            before,
            "catalog seed must not contain duplicate (provider, slug) pairs"
        );
    }

    #[test]
    fn resolve_for_scopes_the_slug_to_the_named_provider() {
        let catalog = Catalog::seed();
        let entry = catalog
            .resolve_for("vertex", "gemini-3-pro")
            .expect("vertex row is seeded");
        assert_eq!(entry.provider, "vertex");
        assert_eq!(entry.tool_dialect, ToolDialect::GeminiFunctions);

        // A slug that exists — but on a different provider — is still a
        // hard error for the provider actually requested.
        let err = catalog.resolve_for("bedrock", "gemini-3-pro").unwrap_err();
        match err {
            ProviderError::UnknownModel { slug } => {
                assert_eq!(slug, "bedrock/gemini-3-pro")
            }
            other => panic!("expected UnknownModel, got {other:?}"),
        }
    }

    #[test]
    fn seed_covers_every_provider_oxagen_cli_can_select() {
        // oxagen-cli/src/config.rs::PROVIDERS lists these providers; this
        // test doesn't import that crate (oxagen-cli depends on
        // oxagen-model, not the reverse) but pins the provider id set here
        // so the two can't silently drift apart again — the actual
        // cross-check lives in oxagen-cli's own test suite (config::tests).
        let catalog = Catalog::seed();
        for provider in [
            "zai",
            "anthropic",
            "openai",
            "xai",
            "deepseek",
            "gemini",
            "openrouter",
            "vertex",
            "bedrock",
        ] {
            assert!(
                catalog.entries().iter().any(|e| e.provider == provider),
                "no catalog entry for provider `{provider}`"
            );
        }
    }
}
