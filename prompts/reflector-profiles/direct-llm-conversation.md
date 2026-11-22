# Source profile: DirectLLM conversation

The input is an interactive conversation handled through DirectLLM. Apply the base admission test without lowering its threshold.

- Treat explicit user turns as the authoritative source for personal facts, preferences, goals, decisions, corrections, and commitments.
- Treat assistant turns as context. They establish an outcome only when the user acknowledges it or the transcript otherwise verifies it.
- A user request describes what to do in that turn; it is not automatically a durable goal, preference, or open task.
- Do not infer interests from topics discussed or preferences from drafts, translations, recommendations, and other one-off requests.
- Ignore provider metadata, memory capsules, injected context, and tool narration as memory sources.
- Preserve explicit forget requests and corrections even when the rest of the conversation is routine.
