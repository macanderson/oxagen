<<<<<<< HEAD:crates/stella-model/src/lib.rs
//! `stella-model` — the `Provider` trait plus its concrete adapters: Z.ai
//! (GLM 5.2, OpenAI-compatible chat), Anthropic (Messages API), and OpenAI
//! (Responses API).
=======
//! `oxagen-model` — the `Provider` trait plus its concrete adapters: Z.ai
//! (GLM 5.2, OpenAI-compatible chat), Anthropic (Messages API), OpenAI
//! (Responses API), Gemini direct (native generateContent), Vertex AI
//! (generateContent, enterprise auth), and Amazon Bedrock (Converse,
//! SigV4-signed).
>>>>>>> 19d73e90c2c817ff663b6b16806253aae5141821:crates/oxagen-model/src/lib.rs
pub mod anthropic;
pub mod bedrock;
pub mod catalog;
pub mod credential;
<<<<<<< HEAD:crates/stella-model/src/lib.rs
pub(crate) mod http;
=======
pub mod gemini;
>>>>>>> 19d73e90c2c817ff663b6b16806253aae5141821:crates/oxagen-model/src/lib.rs
pub mod openai;
pub mod provider;
pub mod sse;
pub mod vertex;
pub mod zai;

pub use catalog::{Catalog, CatalogEntry, Pricing, ToolDialect};
pub use credential::{ApiKey, CredentialError};
pub use provider::Provider;
