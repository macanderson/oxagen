//! `oxagen-tools` — the built-in tool set the agent loop calls.
//!
//! Every tool implements [`Tool`], takes a JSON input from the model, and
//! returns a [`ToolOutput`] (success or a typed, named error — never a bare
//! string). Tools are workspace-root-pinned: file paths resolve against the
//! configured root, and `cd` inside `bash` cannot silently diverge the root
//! for subsequent file operations (L-S2).

pub mod bash;
pub mod edit;
pub mod glob;
pub mod grep;
pub mod read;
pub mod registry;
pub mod write;

pub use registry::ToolRegistry;
