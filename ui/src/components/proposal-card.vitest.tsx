import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { getProposal } = vi.hoisted(() => ({ getProposal: vi.fn() }));
vi.mock('@/lib/api', () => ({ getProposal, decideProposal: vi.fn() }));

import { MarkdownContent } from './markdown-content';

const fence = (id: string) =>
  '```carapaproposal\n' + JSON.stringify({ id }) + '\n```';

const preview = {
  actionType: 'write_item',
  targetPath: '/groups/p/.agent/rules/a.md',
  exists: true,
  replacesSymlink: false,
  symlinkTarget: null,
  contentHidden: false,
  files: [{ path: 'a.md', change: 'modified', diff: '-old\n+new' }],
  problem: null,
};

describe('carapaproposal fence', () => {
  it('shows buttons only for a proposal the server returns', async () => {
    getProposal.mockResolvedValueOnce({
      id: 'prop-1',
      title: 'Tighten rule',
      rationale: 'Because',
      kind: 'rule',
      name: 'a',
      targetLayer: 'project',
      status: 'pending',
      approve: preview,
      deny: null,
      targetChanged: false,
      supported: true,
    });
    getProposal.mockRejectedValueOnce(new Error('Proposal not found'));

    const known = render(
      <MarkdownContent projectFolder="p">{fence('prop-1')}</MarkdownContent>,
    );
    await screen.findByRole('button', { name: /Approve/ });
    expect(screen.getByText('prop-1')).toBeTruthy();
    expect(screen.getByText('/groups/p/.agent/rules/a.md')).toBeTruthy();
    known.unmount();

    // A forged or foreign id stays a plain code block with no actions.
    render(
      <MarkdownContent projectFolder="p">
        {fence('prop-forged')}
      </MarkdownContent>,
    );
    await waitFor(() => expect(getProposal).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole('button', { name: /Approve|Deny|Dismiss/ }),
    ).toBeNull();
    expect(screen.getByText(/prop-forged/)).toBeTruthy();
  });

  it('keeps reading a proposal that is being applied until it finishes', async () => {
    vi.useFakeTimers();
    try {
      const base = {
        id: 'prop-2',
        title: 'Busy',
        rationale: 'Because',
        kind: 'rule',
        name: 'a',
        targetLayer: 'project',
        approve: preview,
        deny: null,
        targetChanged: false,
        supported: true,
        decidedBy: 'alice',
      };
      getProposal
        .mockResolvedValueOnce({ ...base, status: 'applying' })
        .mockResolvedValueOnce({
          ...base,
          status: 'applied',
          result: 'Updated the rule',
        });

      render(
        <MarkdownContent projectFolder="p">{fence('prop-2')}</MarkdownContent>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Applying…')).toBeTruthy();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(screen.getByText('Approved and applied')).toBeTruthy();
      expect(screen.getByText('Updated the rule')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('re-read on focus', () => {
    const focusBase = {
      id: 'prop-4',
      title: 'Focus',
      rationale: 'Because',
      kind: 'rule',
      name: 'a',
      targetLayer: 'project',
      approve: preview,
      deny: null,
      targetChanged: false,
      supported: true,
    };
    const focus = () =>
      act(async () => {
        window.dispatchEvent(new Event('focus'));
      });

    it('shows a decision made elsewhere when the window regains focus', async () => {
      getProposal.mockReset();
      getProposal
        .mockResolvedValueOnce({ ...focusBase, status: 'pending' })
        .mockResolvedValueOnce({
          ...focusBase,
          status: 'denied',
          decidedBy: 'bob',
        });
      render(
        <MarkdownContent projectFolder="p">{fence('prop-4')}</MarkdownContent>,
      );
      await screen.findByRole('button', { name: /Approve/ });

      // The focus listener is attached by a passive effect that React may flush
      // after the card appears, so retry the event until the re-read happens.
      await waitFor(() => {
        window.dispatchEvent(new Event('focus'));
        expect(getProposal).toHaveBeenCalledTimes(2);
      });
      await screen.findByText('Denied');
      expect(screen.queryByRole('button', { name: /Approve|Deny/ })).toBeNull();
    });

    it('does not re-read a proposal in a terminal state', async () => {
      getProposal.mockReset();
      getProposal.mockResolvedValue({ ...focusBase, status: 'denied' });
      render(
        <MarkdownContent projectFolder="p">{fence('prop-4')}</MarkdownContent>,
      );
      await screen.findByText('Denied');

      await focus();
      expect(getProposal).toHaveBeenCalledTimes(1);
    });

    it('keeps the pending card when the re-read fails', async () => {
      getProposal.mockReset();
      getProposal
        .mockResolvedValueOnce({ ...focusBase, status: 'pending' })
        .mockRejectedValueOnce(new Error('offline'));
      const { container } = render(
        <MarkdownContent projectFolder="p">{fence('prop-4')}</MarkdownContent>,
      );
      await screen.findByRole('button', { name: /Approve/ });

      // The focus listener is attached by a passive effect that React may flush
      // after the card appears, so retry the event until the re-read happens.
      await waitFor(() => {
        window.dispatchEvent(new Event('focus'));
        expect(getProposal).toHaveBeenCalledTimes(2);
      });
      expect(
        container
          .querySelector('[data-ui="proposal-card"]')
          ?.getAttribute('data-status'),
      ).toBe('pending');
      expect(screen.getByRole('button', { name: /Approve/ })).toBeTruthy();
    });
  });

  it('renders a merge approval with its task, commit and findings, not a diff', async () => {
    getProposal.mockResolvedValueOnce({
      id: 'prop-3',
      title: 'Merge approval: Add column',
      rationale: 'markdown',
      kind: 'merge',
      name: 'task-1',
      targetLayer: 'project',
      status: 'pending',
      approve: { ...preview, actionType: 'merge_task', files: [] },
      deny: null,
      targetChanged: false,
      supported: true,
      merge: {
        taskId: 'task-1',
        taskTitle: 'Add column',
        headSha: 'abcdef0123456789abcdef0123456789abcdef01',
        findings: [
          {
            ruleId: 'db-migration',
            file: 'drizzle/0001.sql',
            reason: 'Schema',
          },
        ],
        omitted: 0,
      },
    });

    const { container } = render(
      <MarkdownContent projectFolder="p">{fence('prop-3')}</MarkdownContent>,
    );
    await screen.findByRole('button', { name: /Approve/ });

    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Add column' }).getAttribute('href'),
    ).toBe('/board/p?taskId=task-1');
    expect(screen.getByText('abcdef012345')).toBeTruthy();
    expect(screen.getByText('db-migration')).toBeTruthy();
    expect(screen.getByText('drizzle/0001.sql')).toBeTruthy();
    expect(container.querySelector('[data-ui="proposal-diff"]')).toBeNull();
  });
});
