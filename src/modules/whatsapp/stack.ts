import { MCP_WHATSAPP_STACK } from './config.js';
import { getSandboxClient } from '../../lib/mcp-client.js';
import { logger } from '../../logger.js';
import { isSandboxRunning } from '../../sandbox/status.js';

/**
 * Ensure the carapa-wa-link Docker stack is running via CarapaBox.
 * Called once at startup so the messaging client can connect.
 */
export async function ensureWaLinkStack(): Promise<void> {
  const client = getSandboxClient();
  const stack = MCP_WHATSAPP_STACK;

  try {
    const status = await client.sandboxStatus(stack);
    const running = isSandboxRunning(status);

    if (running) {
      logger.info({ stack }, 'WhatsApp stack already running');
      return;
    }

    logger.info({ stack }, 'Starting WhatsApp stack');
    const result = await client.sandboxStart(stack);
    if (result.isError) {
      logger.error(
        { stack, stdoutLength: result.stdout.length },
        'Failed to start WhatsApp stack',
      );
    } else {
      logger.info({ stack }, 'WhatsApp stack started');
    }
  } catch (err) {
    logger.error(
      { err, stack },
      'Failed to ensure WhatsApp stack — messaging may be unavailable',
    );
  }
}
