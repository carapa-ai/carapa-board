import type { Memory } from './types.js';

export function memoryAuditPromptForCluster(memories: Memory[]): string {
  const payload = memories.map((memory) => ({
    id: memory.id,
    content: memory.content,
    memory_type: memory.memory_type,
    importance: memory.importance,
    tags: memory.tags ?? [],
    source: memory.source,
    source_ref: memory.sourceRef ?? null,
    valid_from: memory.valid_from ?? null,
  }));
  return `You are CarapaBoard's project memory auditor. Evaluate the supplied current memories with very high precision. The supplied memories form a semantic similarity cluster, so explicitly check for duplication and possible merges within it.

Memory value includes both decision quality and retrieval savings. Keep durable knowledge whose loss could cause a future agent to make a materially wrong, redundant, unsafe, or inconsistent decision OR force it to rediscover useful project structure through repository searches. Preserve stable user preferences, rationale, architecture decisions, constraints, conventions, important entry points, and accurate summaries of recurring implementation patterns.

A concise, accurate memory can be valuable as a semantic index into the repository. Keep facts that help an agent locate relevant code, recognize a project pattern, or learn a restriction before it starts searching. Repository discoverability alone is never a reason to erase a memory. When unchanged code verifies such a fact, cite it as durable evidence for keep or rewrite. If a useful fact is accurate but noisy, overly specific, or poorly phrased, prefer rewrite to erase.

Routine logs, completed-task status, one-off debugging steps, incidental symbol names, and isolated details that provide no durable navigation, pattern-recognition, constraint, or decision value remain low value. Do not keep a claim merely because some code excerpt is true; judge whether the claim saves meaningful future search or guides future work.

You are running read-only in the project's sandbox. Inspect repository files only when it materially improves confidence. Never modify files, run destructive commands, contact people, or invoke CarapaBoard mutation tools. If you cite code, use paths under the visible workspace roots and quote a short exact excerpt. For broad or negative claims include watched_scope naming the configuration/source file whose unchanged hash is sufficient to re-use the proof.

Allowed dispositions:
- keep: valuable and canonical, including useful repository indexes, or cleanup is uncertain
- rewrite: valuable but inaccurate, noisy, overly specific, or badly phrased
- merge: redundant with another supplied memory; merge_target_id is the canonical supplied memory
- erase: inaccurate, obsolete, incoherent, redundant without unique value, task residue, or accurate trivia with no durable search/navigation/decision value

Never erase an accurate, useful memory solely because the same fact can be found in code. Unaccepted assistant speculation is not a fact. Lack of code evidence is never evidence for erase. Return every supplied ID exactly once. Use confidence 0..1. Rewrite/merge below 0.85 and erase below 0.90 will be converted to keep.

Return only JSON:
{"items":[{"memory_id":"id","disposition":"keep|rewrite|merge|erase","confidence":0.95,"reason":"concise reason","proposed_content":"rewrite only","proposed_memory_type":"decision","proposed_importance":0.8,"proposed_tags":["architecture"],"merge_target_id":"merge only","evidence":[{"repository_root":"/workspace/repo","path":"src/file.ts","line_start":1,"line_end":3,"excerpt":"exact text","watched_scope":"optional/file"}]}]}

MEMORIES:
${JSON.stringify(payload)}`;
}
