import { ipcRelay } from '../../agent-runner.js';
import { getTask } from '../../db.js';
import { logger } from '../../logger.js';
import { broadcast } from '../objectives/ws-events.js';
import { appendTaskMessageDurableAsync } from '../transcripts/transcript-store.js';
import { getMessagingProvider } from './registry.js';

/** Deliver board messages locally; external chats use the optional provider. */
export async function sendMessage(jid: string, text: string): Promise<void> {
  if (jid.includes('@bridge')) {
    ipcRelay.emit('message', { jid, text });
    return;
  }

  if (jid.endsWith('@kanban')) {
    const match = jid.match(/^task-(.+)@kanban$/);
    if (match) {
      const task_id = match[1];
      const task = await getTask(task_id);
      if (task) {
        const message = await appendTaskMessageDurableAsync(task.project_id, {
          task_id,
          role: 'assistant',
          content: text,
          created_at: new Date().toISOString(),
        });
        broadcast({
          type: 'task_message',
          payload: { ...message, task_id, project_id: task.project_id },
        });
        logger.info({ task_id }, 'Task message saved via sendMessage');
      } else {
        logger.warn({ task_id }, 'Task not found for @kanban message');
      }
      return;
    }
  }

  const provider = getMessagingProvider();
  if (!provider) {
    logger.warn({ jid }, 'External message skipped: messaging is disabled');
    return;
  }
  await provider.sendMessage(jid, text);
}
