# Chunk Planner Skill

Purpose: split only the work that benefits from splitting.

Rules:

- Do not chunk one-line or short direct answers.
- Chunk detailed research into independent sections plus optional synthesis.
- Chunk code only when the request needs multiple responsibilities or asks for code plus explanation.
- Preserve dependencies: tests depend on implementation, final synthesis depends on sections, and usage notes depend on the final source.
- If only one capable node is available, chunk only when it improves output quality or avoids token limits.
- Return completed sections to the UI as they finish; do not hide useful section outputs behind a thin final answer.

