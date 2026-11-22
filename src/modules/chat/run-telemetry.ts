import type { ContainerOutput } from '../../sandbox/process.js';

/**
 * Consolidated per-turn telemetry for a sandbox run, as persisted in the
 * transcript's `type:"telemetry"` row and rendered in the message footer.
 * Shared by the live path and restart recovery so both write the same shape.
 */
export function buildSandboxRunTelemetry(
  output: ContainerOutput,
  fallback: { modelName?: string | null; contextSize?: number | null },
): Record<string, unknown> {
  return {
    // Preserve unknown usage as absent. In particular, Codex can finish
    // without a usage-bearing turn.completed event; serializing undefined
    // as tok_input:0 incorrectly claims the provider reported zero input.
    tok_input: output.tok_input,
    tok_output: output.tok_output,
    total_tokens: output.total_tokens,
    tok_context_last: output.tok_context_last,
    tok_cache_read: output.tok_cache_read,
    tok_cache_write: output.tok_cache_write,
    tok_reasoning: output.tok_reasoning,
    inputTokenSemantics: output.inputTokenSemantics ?? 'fresh',
    // Codex events carry no model field; fall back to the agent profile's
    // configured model so the telemetry bar can show a model label.
    model_name: output.model_name || fallback.modelName || undefined,
    context_size: fallback.contextSize || undefined,
    usageSource: output.usageSource,
    rawUsage: output.rawUsage,
    // The provider's prompt cache stays warm this long after the turn's last request.
    cache_expires_at_ms: output.cache_ttl_s
      ? Date.now() + output.cache_ttl_s * 1000
      : undefined,
    prompt_dispatched_at_ms: output.prompt_dispatched_at_ms,
    first_output_at_ms: output.first_output_at_ms,
    time_to_first_output_ms: output.time_to_first_output_ms,
    duration_ms: output.duration,
    cost_usd: output.cost_usd,
    // session_id must be the real Claude session UUID (newSessionId), NOT the
    // sandbox_instance (Docker container name like "carapa"). Using sandbox_instance
    // here writes misleading transcript telemetry and breaks tooling that
    // displays or audits the underlying CLI session.
    session_id: output.newSessionId,
  };
}
