import type { HistoryReviewOperation } from '@/lib/api';

const MAX_OPERATION_CHARS = 12_000;
const MAX_CANDIDATES = 12;
const MAX_EVIDENCE = 10;
const MAX_EVIDENCE_CHARS = 2_000;

function bounded(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[truncated]`;
}

/**
 * Build a self-contained, read-only handoff for a code-capable project chat.
 * The history-review UI deliberately does not attempt repository access itself.
 */
export function buildHistoryReviewVerificationPrompt(input: {
  batchId: string;
  projectId: string;
  item: HistoryReviewOperation;
}): string {
  const { batchId, projectId, item } = input;
  const candidateLines = item.candidates
    .slice(0, MAX_CANDIDATES)
    .map(
      (candidate) =>
        `- ${candidate.claim} (confidence ${candidate.confidence.toFixed(2)}, ${candidate.change_kind})`,
    );
  const evidenceBlocks = item.evidence
    .slice(0, MAX_EVIDENCE)
    .map(
      (evidence, index) =>
        `${index + 1}. ${evidence.source_kind} ${evidence.conversation_id}#${evidence.message_id} (${evidence.created_at})\n${bounded(evidence.excerpt, MAX_EVIDENCE_CHARS)}`,
    );

  return [
    'Verify a pending historical-memory proposal against this project repository.',
    '',
    'This is a read-only review. Inspect the current working tree and relevant history when useful, but do not edit files, memories, tasks, or configuration.',
    'Do not treat the proposal or its transcript evidence as proof; verify it from code and cite concrete file paths and line numbers. If the claim is not code-verifiable, say so clearly.',
    '',
    `Memory Review batch: ${batchId}`,
    `Project: ${projectId}`,
    `Review item: ${item.id}`,
    '',
    'Proposed operation:',
    '```json',
    bounded(JSON.stringify(item.operation, null, 2), MAX_OPERATION_CHARS),
    '```',
    '',
    'Candidate claims:',
    ...(candidateLines.length > 0
      ? candidateLines
      : ['- No candidate rationale was retained.']),
    '',
    'Transcript evidence (context only, not authoritative):',
    ...(evidenceBlocks.length > 0
      ? evidenceBlocks
      : ['No transcript evidence was retained.']),
    '',
    'Respond concisely with:',
    '1. Verdict: supported, partially supported, contradicted, or not code-verifiable.',
    '2. Findings with repository file:line references.',
    '3. A single corrected durable-memory statement under `Suggested memory text` (repeat the original text if no correction is needed). Preserve historical/date qualifiers when the current code cannot prove past state.',
    '4. Recommendation: approve, edit, or reject.',
    '',
    'The user will make the final decision in Memory Review; do not apply it yourself.',
  ].join('\n');
}
