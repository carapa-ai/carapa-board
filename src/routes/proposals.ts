/**
 * Agent-proposed rule/skill changes: read one proposal and decide it.
 *
 * Only a signed-in user session may decide. Agent MCP tokens are refused so an
 * agent can never approve its own proposal.
 */
import { Router } from 'express';
import { getGroupByFolder } from '../state-manager.js';
import { logger } from '../logger.js';
import {
  parseAction,
  PROMPT_PROPOSAL_KIND,
  UnsupportedLayerError,
} from '../modules/proposals/actions.js';
import { getProposal } from '../modules/proposals/db-proposals.js';
import { isPromotionLayer } from '../modules/proposals/promotion-targets.js';
import { assertPromptApprover } from '../modules/proposals/prompt-proposals.js';
import {
  decideProposal,
  presentProposal,
  ProposalAlreadyDecidedError,
} from '../modules/proposals/service.js';
import { callerKind, requireConversationAccess } from './_helpers.js';

const router = Router();

/** The proposal, only when it belongs to the project in the URL. */
async function findProjectProposal(pid: string, id: string) {
  const proposal = await getProposal(id);
  return proposal && proposal.project_id === pid ? proposal : null;
}

router.get('/projects/:pid/proposals/:id', async (req: any, res) => {
  if (!getGroupByFolder(req.params.pid)) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const proposal = await findProjectProposal(req.params.pid, req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  if (
    !(await requireConversationAccess(
      req,
      res,
      proposal.conversation_id,
      'read',
    ))
  ) {
    return;
  }
  res.json({ proposal: await presentProposal(proposal) });
});

for (const decision of ['approve', 'deny'] as const) {
  router.post(
    `/projects/:pid/proposals/:id/${decision}`,
    async (req: any, res) => {
      if (!req.authUser || callerKind(req) !== 'human') {
        return res
          .status(403)
          .json({ error: 'Only a signed-in user can decide a proposal' });
      }
      if (!getGroupByFolder(req.params.pid)) {
        return res.status(404).json({ error: 'Project not found' });
      }
      const proposal = await findProjectProposal(req.params.pid, req.params.id);
      if (!proposal)
        return res.status(404).json({ error: 'Proposal not found' });
      if (
        !(await requireConversationAccess(
          req,
          res,
          proposal.conversation_id,
          'write',
        ))
      ) {
        return;
      }
      // A platform/template commit changes a shared repository, which no
      // project-level conversation access entitles anyone to do.
      if (
        decision === 'approve' &&
        isPromotionLayer(proposal.target_layer) &&
        req.authUser.role !== 'admin'
      ) {
        return res.status(403).json({
          error: 'Only an admin can approve a platform or template proposal',
        });
      }
      // A prompt change needs rights on the target project, which is not the
      // conversation's project. Any failure to establish them refuses.
      if (decision === 'approve' && proposal.kind === PROMPT_PROPOSAL_KIND) {
        try {
          const action = parseAction(proposal.approve_action);
          if (action.type !== 'set_prompt') throw new Error('Not a prompt');
          await assertPromptApprover(req.authUser, action.target_project);
        } catch {
          return res.status(403).json({
            error:
              'Approving a prompt change needs owner or editor access to the target project',
          });
        }
      }
      try {
        const decided = await decideProposal(
          proposal,
          decision,
          req.authUser.username ?? req.authUser.id,
        );
        res.json({ proposal: await presentProposal(decided) });
      } catch (err) {
        if (err instanceof UnsupportedLayerError) {
          return res.status(501).json({ error: err.message });
        }
        if (err instanceof ProposalAlreadyDecidedError) {
          const current = await getProposal(proposal.id);
          return res.status(409).json({
            error: err.message,
            proposal: current ? await presentProposal(current) : undefined,
          });
        }
        logger.error(
          { err, proposalId: proposal.id },
          'Proposal decision failed',
        );
        res.status(500).json({ error: 'Failed to decide proposal' });
      }
    },
  );
}

export default router;
