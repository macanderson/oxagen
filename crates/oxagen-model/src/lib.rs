//! `oxagen-model` Phase 0 spike: the `Provider` trait plus Z.ai and
//! Anthropic adapters.
pub mod anthropic;
pub mod catalog;
pub mod credential;
pub mod provider;
pub mod sse;
pub mod zai;

pub use catalog::{Catalog, CatalogEntry, ToolDialect};
pub use credential::{ApiKey, CredentialError};
pub use provider::Provider;
