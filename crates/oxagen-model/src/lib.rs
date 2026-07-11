//! `oxagen-model` — the `Provider` trait plus its concrete adapters: Z.ai
//! (GLM 5.2, OpenAI-compatible chat), Anthropic (Messages API), and OpenAI
//! (Responses API).
pub mod anthropic;
pub mod catalog;
pub mod credential;
pub mod openai;
pub mod provider;
pub mod sse;
pub mod zai;

pub use catalog::{Catalog, CatalogEntry, ToolDialect};
pub use credential::{ApiKey, CredentialError};
pub use provider::Provider;
