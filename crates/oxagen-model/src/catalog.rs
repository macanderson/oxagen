//! Model catalog skeleton. Binding rule from
//! `docs/specs/oxagen-rust-cli/07-model-matrix.md` §3: **a slug not present
//! in the catalog is a hard, immediate, named error, never a silent
//! fallback** (the TS-era phantom `glm-5.2-turbo` slug and gateway
//! slug-drift lessons, L-M1/L-M2). Phase 0 ships a curated in-binary seed
//! for the two spiked providers; `oxagen models refresh` (a real network
//! call against each provider's `/models` endpoint) is Phase 1+ scope.

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
    /// Phase 0 seed: exactly the two spiked providers/models. Later phases
    /// grow this via `oxagen models refresh` merging in live `/models`
    /// data; the shape does not change, only the row count.
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
}
