mod weather;

use crate::contracts::ChatMessage;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolAnswer {
    pub content: String,
    pub name: &'static str,
}

pub fn execute(messages: &[ChatMessage]) -> Result<Option<ToolAnswer>, String> {
    weather::execute(messages)
}
