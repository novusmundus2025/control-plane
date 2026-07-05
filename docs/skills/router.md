# Router Skill

Purpose: decide whether a chat request should use deterministic tools, a single LLM job, or a decomposed job graph.

Rules:

- For multi-intent prompts, call the planner first. The planner returns strict JSON describing each intent and which tool or API should handle it.
- Use deterministic extraction only as a fallback when the planner is unavailable or returns invalid JSON.
- Route weather, current factual lookups, assistant identity, simple polynomial calculus, and simple linear equations to tools when a matching tool exists.
- Route short conversational prompts to a single direct response.
- Route complete code plus explanation, advanced nested calculus, detailed research, and multi-deliverable work to decomposition.
- Preserve the user's original intent. Do not rewrite, complete, or expand the user's prompt before answering.
- Answer only what the user asked. Do not add inferred follow-up questions or extra biographies.
- For multi-intent prompts, answer each planned intent once, in the user's order.
