import { and, asc, eq, inArray } from 'drizzle-orm';

import { drizzleDbRef } from '../../src/db/drizzle-client.js';
import { proposals } from '../../src/db/schema.js';
import { createProposals } from '../../src/modules/proposals/service.js';

const RULE_NAME = 'ui-sandbox-review-checklist';
const SKILL_NAME = 'ui-sandbox-release-notes';

const RULE_CONTENT =
  '---\ntrigger: model_decision\ndescription: Review checklist for UI sandbox changes.\n---\n# Review checklist\n\n- Run the tests before asking for review.\n';

const SKILL_CONTENT =
  '---\nname: ui-sandbox-release-notes\ndescription: Draft release notes from merged tasks. Use when asked for release notes.\n---\n# Release notes\n\nList the merged tasks as short, user-facing bullet points.\n';

/**
 * Seed one pending conversation with a rule and a skill proposal for
 * `projectId`, through the real `createProposals` so validation and the base
 * hash stay real. Reruns on the same data root return the existing rows.
 */
export async function seedProposalFixtures(
  projectId: string,
): Promise<{ conversation_id: string; proposal_ids: string[] }> {
  const existing = await drizzleDbRef.current
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.project_id, projectId),
        inArray(proposals.name, [RULE_NAME, SKILL_NAME]),
      ),
    )
    .orderBy(asc(proposals.created_at), asc(proposals.id));
  if (existing.length > 0) {
    return {
      conversation_id: existing[0].conversation_id,
      proposal_ids: existing.map((row) => row.id),
    };
  }

  return createProposals({
    project_id: projectId,
    title: 'UI sandbox proposals',
    proposals: [
      {
        kind: 'rule',
        name: RULE_NAME,
        target_layer: 'project',
        rationale:
          'A short review checklist so every change gets tested before review.',
        approve_action: {
          type: 'write_item',
          files: [{ path: `${RULE_NAME}.md`, content: RULE_CONTENT }],
        },
      },
      {
        kind: 'skill',
        name: SKILL_NAME,
        target_layer: 'project',
        rationale: 'A minimal skill for drafting release notes.',
        approve_action: {
          type: 'write_item',
          files: [{ path: 'SKILL.md', content: SKILL_CONTENT }],
        },
      },
    ],
  });
}
