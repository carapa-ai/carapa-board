import * as db from '../../db.js';
import { logger } from '../../logger.js';
import {
  crossProjectReadAllowed,
  PrivacyRefusal,
} from '../../lib/privacy-policy.js';

/**
 * A strict project must not write into a knowledge base that is also shared
 * with a project that is not strict: that project's cloud agent could read the
 * content back through search/read. Knowledge bases have no owner, so every
 * other sharer is checked against the writer.
 */
export async function assertKnowledgeWriteAllowed(
  kbId: string,
  writer: string,
): Promise<void> {
  const others = (await db.getKnowledgeBaseShares(kbId)).filter(
    (folder) => folder !== writer,
  );
  for (const other of others) {
    if (crossProjectReadAllowed(writer, other, 'agent')) continue;
    const target = `knowledge_base:${kbId}`;
    logger.warn(
      {
        event: 'privacy_refusal',
        projectId: writer,
        purpose: 'agent',
        mode: 'strict',
        target,
      },
      'privacy_refusal',
    );
    throw new PrivacyRefusal({
      projectId: writer,
      purpose: 'agent',
      mode: 'strict',
      target,
      message:
        'Privacy mode "strict" refuses writing to a knowledge base shared with a project that is not strict',
    });
  }
}
