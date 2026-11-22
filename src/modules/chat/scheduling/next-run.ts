import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../../config.js';
import { logger } from '../../../logger.js';
import { parseIntervalMs } from './interval.js';
import type { ScheduledTask } from './types.js';

export function calcNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, {
        tz: TIMEZONE,
      });
      return interval.next().toISOString();
    } catch {
      // Scheduled tasks may predate current API validation or have been
      // imported directly. Do not leave an invalid cron row due forever.
      logger.warn(
        { task_id: task.id, schedule_value: task.schedule_value },
        'Invalid cron schedule_value, skipping next_run',
      );
      return null;
    }
  }

  if (task.schedule_type === 'interval') {
    try {
      const ms = parseIntervalMs(task.schedule_value);
      return new Date(Date.now() + ms).toISOString();
    } catch {
      logger.warn(
        { task_id: task.id, schedule_value: task.schedule_value },
        'Invalid interval schedule_value, skipping next_run',
      );
    }
  }

  // One-off tasks have no recurring next run. Resume callers preserve their
  // original timestamp instead of replacing it with this null result.
  return null;
}
