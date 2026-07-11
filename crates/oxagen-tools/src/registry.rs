//! Tool trait + registry. The agent loop drives every tool through
//! `ToolRegistry::execute` — no tool-specific code lives outside this crate.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use oxagen_protocol::tool::{ToolOutput, ToolSchema};
use serde_json::Value;

/// One tool the agent can call. Input arrives as the model-produced JSON;
/// output is always a typed `ToolOutput` (never a bare string).
#[async_trait]
pub trait Tool: Send + Sync {
    /// Schema advertised to the model: name, description, JSON Schema.
    fn schema(&self) -> ToolSchema;

    /// Execute the tool. `root` is the workspace root for path resolution;
    /// tools must never read or write outside it without explicit opt-in.
    async fn execute(&self, input: &Value, root: &std::path::Path) -> ToolOutput;
}

/// Registry of all built-in tools, keyed by name.
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
    root: PathBuf,
}

impl ToolRegistry {
    pub fn new(root: PathBuf) -> Self {
        let mut tools: HashMap<String, Arc<dyn Tool>> = HashMap::new();
        let entries: Vec<Arc<dyn Tool>> = vec![
            Arc::new(crate::read::ReadFile),
            Arc::new(crate::write::WriteFile),
            Arc::new(crate::edit::EditFile),
            Arc::new(crate::bash::Bash),
            Arc::new(crate::grep::Grep),
            Arc::new(crate::glob::Glob),
        ];
        for tool in entries {
            let name = tool.schema().name;
            tools.insert(name, tool);
        }
        Self { tools, root }
    }

    /// All tool schemas, for advertising to the model.
    pub fn schemas(&self) -> Vec<ToolSchema> {
        self.tools.values().map(|t| t.schema()).collect()
    }

    /// Execute a tool by name. Returns an error `ToolOutput` if the name is
    /// unknown or the input is malformed — never panics.
    pub async fn execute(&self, name: &str, input: &Value) -> ToolOutput {
        match self.tools.get(name) {
            Some(tool) => tool.execute(input, &self.root).await,
            None => ToolOutput::Error {
                message: format!(
                    "unknown tool `{name}` — available: {}",
                    self.available_names()
                ),
            },
        }
    }

    pub fn available_names(&self) -> String {
        let mut names: Vec<&str> = self.tools.keys().map(|s| s.as_str()).collect();
        names.sort();
        names.join(", ")
    }

    pub fn root(&self) -> &PathBuf {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unknown_tool_returns_error_not_panic() {
        let reg = ToolRegistry::new(PathBuf::from("/tmp"));
        let result = reg.execute("nonexistent", &Value::Null).await;
        assert!(result.is_error());
    }

    #[test]
    fn registry_advertises_all_six_tools() {
        let reg = ToolRegistry::new(PathBuf::from("/tmp"));
        let names: Vec<String> = reg.schemas().iter().map(|s| s.name.clone()).collect();
        assert!(names.contains(&"read_file".to_string()));
        assert!(names.contains(&"write_file".to_string()));
        assert!(names.contains(&"edit_file".to_string()));
        assert!(names.contains(&"bash".to_string()));
        assert!(names.contains(&"grep".to_string()));
        assert!(names.contains(&"glob".to_string()));
    }
}
