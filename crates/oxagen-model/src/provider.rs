//! Re-exports the `Provider` port. The trait itself lives in
//! `oxagen-protocol` (`02-architecture.md` §3) so `oxagen-core` can drive
//! every model call through `&dyn Provider` without depending on any
//! concrete adapter; every adapter in this crate implements it.

pub use oxagen_protocol::Provider;
