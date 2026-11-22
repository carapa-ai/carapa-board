import { describe, expect, it } from 'vitest';
import type { AttentionItem, UnreadNotification } from '@/lib/api';
import { partitionAttention } from './attention';

const conversation: AttentionItem = {
  kind: 'conversation',
  id: 'conv-1',
  projectId: 'p1',
  objectiveId: 'obj-1',
  title: 'Reply',
  state: 'unread',
  at: '2026-11-13T10:00:00.000Z',
};

function notification(id: string, actionUrl: string): UnreadNotification {
  return {
    id,
    kind: 'text',
    summary: id,
    action_url: actionUrl,
    created_at: '2026-11-13T09:00:00.000Z',
  };
}

describe('partitionAttention', () => {
  it('keeps objective notifications in the bell and attaches conversation ones to their row', () => {
    const { groups, bellNotifications } = partitionAttention(
      [conversation],
      [
        notification('n-obj', '/objective/p1/obj-1'),
        notification('n-obj-q', '/objective/p1/obj-1?report=x.md'),
        notification('n-conv', '/chat/p1?conversationId=conv-1'),
      ],
    );
    expect(bellNotifications.map((n) => n.id)).toEqual(['n-obj', 'n-obj-q']);
    expect(groups.unread).toHaveLength(1);
    expect(groups.unread[0].notificationIds).toEqual(['n-conv']);
  });
});
