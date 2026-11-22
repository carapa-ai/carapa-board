import { z } from 'zod';
import type { ToolDefinition } from '../tools/types.js';
import { ProposalValidationError } from './actions.js';
import {
  createProposals,
  MAX_PROPOSALS_PER_CALL,
  proposalInputSchema,
} from './service.js';

export const proposeChangesTool: ToolDefinition = {
  name: 'propose_changes',
  description:
    'Propose changes to rules, skills or project prompts for the user to approve or deny with a button. ' +
    'When the user started this chat turn, the cards (one per proposal) are posted in the current chat. Otherwise (scheduled, Brain or task runs) a NEW pending conversation (in the given objective, or in this project) holds them. Nothing changes until the user approves. ' +
    'Each proposal carries a typed approve_action (write_item with the complete files, delete_item, mark_local, or none) and an optional deny_action. ' +
    'target_layer "project" and "objective" change files in place. "platform", "group_template" and "objective_template" must use write_item (deny only dismisses): on approval the change is committed to its source repository and agents see it after the next update_skill.sh. ' +
    'write_item replaces the whole skill folder or rule file; rule files must keep their frontmatter. ' +
    'kind "prompt" proposes a system, worker or stage prompt of a project you have project_setup:read on (the card stays in this chat): name is "system", "worker" or "stage-<stage_id>" (dots in the stage id become dashes), target_layer "project", approve_action {type "set_prompt", target_project, expected_revision from get_project_setup, prompt_type system|worker|stage, stage_id (stage only), content (max 100000 chars; null or blank removes the prompt)}, and no deny_action other than none. Creation checks the revision and stage like set_project_prompt. The user sees a diff; approving needs owner or editor access to target_project (or an admin), and applies exactly what set_project_prompt would, unless that prompt changed after the proposal (then it goes stale and nothing is written). ' +
    'Returns the id of the conversation holding the cards (the current chat or the new one) and the proposal ids.',
  inputSchema: {
    title: z
      .string()
      .min(1)
      .max(120)
      .describe(
        'Heading of the proposals message, and the title of the new conversation when one is created, e.g. "Promote the review rule"',
      ),
    objective_id: z
      .string()
      .optional()
      .describe(
        'Objective the proposals belong to (must belong to the project); the cards go to the current chat only when it is this objective\'s chat, otherwise to a new conversation in it. Required for target_layer "objective".',
      ),
    proposals: z
      .array(proposalInputSchema)
      .min(1)
      .max(MAX_PROPOSALS_PER_CALL)
      .describe('One entry per rule, skill or prompt change'),
  },
  requiredPermissions: ['chat:write'],
  handler: async (
    args,
    _deps,
    {
      group_folder,
      run_id,
      task_id,
      conversation_id,
      trigger_source,
      permissions,
    },
  ) => {
    try {
      const result = await createProposals({
        project_id: group_folder,
        objective_id: args.objective_id,
        title: args.title,
        proposals: args.proposals,
        created_by_run: run_id ?? null,
        permissions,
        run: { conversation_id, task_id, run_id, trigger_source },
      });
      return {
        conversation_id: result.conversation_id,
        proposal_ids: result.proposal_ids,
      };
    } catch (err) {
      if (err instanceof ProposalValidationError) {
        throw new Error(`propose_changes rejected: ${err.message}`);
      }
      throw err;
    }
  },
};
