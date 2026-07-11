//! Credential resolution. Never `Display`/`Debug`-leaks the secret value —
//! credentials are never logged, never in trace JSONL
//! (`docs/specs/oxagen-rust-cli/02-architecture.md` §8).
//!
//! Resolution order per `01-product-spec.md` §4: CLI flag -> env var ->
//! provider-native config -> interactive prompt on first use. Phase 0 spike
//! implements the env-var step only (the other steps need `oxagen-cli`'s
//! config/TOML layer, out of scope here).

use std::fmt;

use thiserror::Error;

#[derive(Error, Debug, PartialEq, Eq)]
pub enum CredentialError {
    #[error(
        "no credential found for `{env_var}` — set the environment variable or pass it via config"
    )]
    NotFound { env_var: String },
    #[error("credential for `{env_var}` is empty")]
    Empty { env_var: String },
}

/// A secret API key. Deliberately has no `Display` and a redacted `Debug`
/// so a stray `println!`/`tracing::info!` can never leak it.
#[derive(Clone)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Resolve from an environment variable. This is the only resolution
    /// step the Phase 0 spike needs; later phases add the flag/config/
    /// prompt steps ahead of this one in the chain.
    pub fn from_env(env_var: &str) -> Result<Self, CredentialError> {
        match std::env::var(env_var) {
            Ok(value) if !value.is_empty() => Ok(Self(value)),
            Ok(_) => Err(CredentialError::Empty {
                env_var: env_var.to_string(),
            }),
            Err(_) => Err(CredentialError::NotFound {
                env_var: env_var.to_string(),
            }),
        }
    }

    /// The only sanctioned way to read the secret value — for building an
    /// auth header, nothing else.
    pub fn reveal(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("ApiKey").field(&"<redacted>").finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_prints_the_secret_value() {
        let key = ApiKey::new("sk-super-secret-value");
        let debug = format!("{key:?}");
        assert!(!debug.contains("sk-super-secret-value"));
        assert!(debug.contains("redacted"));
    }

    #[test]
    fn from_env_missing_var_is_not_found() {
        // Use a var name that will not realistically be set in CI/dev.
        let err = ApiKey::from_env("OXAGEN_TEST_DEFINITELY_UNSET_VAR_12345").unwrap_err();
        assert_eq!(
            err,
            CredentialError::NotFound {
                env_var: "OXAGEN_TEST_DEFINITELY_UNSET_VAR_12345".into()
            }
        );
    }

    #[test]
    fn from_env_present_var_resolves_and_reveals() {
        // SAFETY: test-only env mutation, no concurrent access to this var
        // from other tests (unique name per test).
        unsafe {
            std::env::set_var("OXAGEN_TEST_CREDENTIAL_VAR", "sk-test-value");
        }
        let key = ApiKey::from_env("OXAGEN_TEST_CREDENTIAL_VAR").unwrap();
        assert_eq!(key.reveal(), "sk-test-value");
        unsafe {
            std::env::remove_var("OXAGEN_TEST_CREDENTIAL_VAR");
        }
    }

    #[test]
    fn from_env_empty_var_is_reported_as_empty_not_not_found() {
        unsafe {
            std::env::set_var("OXAGEN_TEST_EMPTY_CREDENTIAL_VAR", "");
        }
        let err = ApiKey::from_env("OXAGEN_TEST_EMPTY_CREDENTIAL_VAR").unwrap_err();
        assert_eq!(
            err,
            CredentialError::Empty {
                env_var: "OXAGEN_TEST_EMPTY_CREDENTIAL_VAR".into()
            }
        );
        unsafe {
            std::env::remove_var("OXAGEN_TEST_EMPTY_CREDENTIAL_VAR");
        }
    }
}
