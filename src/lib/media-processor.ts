/**
 * Media attachment processing for incoming messages.
 *
 * Handles three attachment types:
 *   - audio:    transcribed via OpenAI Whisper (or compatible endpoint)
 *               otherwise falls back to a "[Image: filename]" placeholder
 *   - document: text is inlined for plain-text mimetypes; all others become a placeholder
 *
 * carapa-wa-link contract:
 *   Each RemoteMessage may include an `attachments` array. Every attachment must supply
 *   a `url` that this service can fetch (authenticated via CARAPA_WA_LINK_TOKEN). The URL
 *   should point to carapa-wa-link's media download endpoint, e.g.:
 *     GET /api/media/:messageId   → raw binary body
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import {
  CARAPA_WA_LINK_TOKEN,
  MCP_WHATSAPP_BASE_URL,
  ENABLE_VIDEO,
} from '../config.js';
import type { RemoteMessage } from '../modules/messaging/types.js';
import { getTranscriber } from '../modules/whisper/index.js';
import type { ChatMessageAttachment } from '../modules/chat/types.js';

export interface EnrichOptions {
  /** Host directory to save downloaded media files into */
  saveDir?: string;
  /** Container-visible path prefix (e.g. /workspace/ipc/uploads) */
  containerPrefix?: string;
  /** Web UI accessible URL prefix (e.g. /uploads/main) */
  browserUrlPrefix?: string;
  /** When true, skip Whisper and keep audio as a native LLM attachment */
  nativeAudio?: boolean;
}

/** Download media from a URL. Passes auth token when configured. */
async function fetchMedia(url: string): Promise<Buffer> {
  const headers: Record<string, string> = {};
  if (CARAPA_WA_LINK_TOKEN) {
    headers['Authorization'] = `Bearer ${CARAPA_WA_LINK_TOKEN}`;
  }
  // Resolve relative URLs (e.g. /api/media/...) against carapa-wa-link base URL
  const resolvedUrl = url.startsWith('/')
    ? `${MCP_WHATSAPP_BASE_URL}${url}`
    : url;
  const res = await fetch(resolvedUrl, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch media from ${url}: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Derive a reasonable file extension from a mimetype. */
function extFromMimetype(mimetype: string): string {
  const map: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'mp4',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/x-matroska': 'mkv',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
  };
  return map[mimetype] ?? mimetype.split('/').pop() ?? 'bin';
}

// ---------------------------------------------------------------------------
// Document → text (plain text inline; others placeholder)
// ---------------------------------------------------------------------------

async function extractDocumentText(
  buffer: Buffer,
  mimetype: string,
  filename?: string,
  caption?: string,
): Promise<string> {
  const displayName = filename || `file.${extFromMimetype(mimetype)}`;
  const captionNote = caption ? ` (caption: "${caption}")` : '';

  if (mimetype === 'text/plain') {
    const text = buffer.toString('utf-8').trim();
    const label =
      displayName !== `file.txt` ? `[Document: ${displayName}]\n` : '';
    return `${label}${text}`;
  }

  // Future: add PDF text extraction here (e.g. pdf-parse) without heavy deps.
  // For now, emit a clear placeholder so the agent knows a file was attached.
  return `[Document: ${displayName}${captionNote}]`;
}

// ---------------------------------------------------------------------------
// Public: enrich a message's content by processing all attachments
// ---------------------------------------------------------------------------

/**
 * Process all attachments on a message and return an enriched content string.
 * The original `msg.content` (caption text) is preserved; attachment results
 * are appended below it.
 *
 * If there are no attachments or processing fails, the original content is returned.
 */
export interface EnrichedContent {
  forAgent: string;
  forDb: string;
  attachments?: ChatMessageAttachment[];
}

export async function enrichMessageContent(
  msg: RemoteMessage,
  options?: EnrichOptions,
): Promise<EnrichedContent> {
  if (!msg.attachments || msg.attachments.length === 0) {
    return { forAgent: msg.content, forDb: msg.content };
  }

  const agentParts: string[] = [];
  const dbParts: string[] = [];
  const enrichedAttachments: ChatMessageAttachment[] = [];
  if (msg.content.trim()) {
    agentParts.push(msg.content.trim());
    dbParts.push(msg.content.trim());
  }

  for (const attachment of msg.attachments) {
    let localPath: string | undefined;
    let storedName: string | undefined;
    try {
      // Re-classify based on mimetype if needed
      if (attachment.type === 'document') {
        if (attachment.mimetype.startsWith('image/'))
          (attachment as any).type = 'image';
        else if (attachment.mimetype.startsWith('video/') && ENABLE_VIDEO)
          (attachment as any).type = 'video';
        else if (attachment.mimetype.startsWith('audio/'))
          (attachment as any).type = 'audio';
      }

      const buffer = await fetchMedia(attachment.url);
      let resultForAgent = '';
      let resultForDb: string | null = null;

      if (attachment.type === 'audio') {
        if (options?.nativeAudio) {
          const name = attachment.filename || 'voice message';
          const caption = attachment.caption?.trim();
          resultForAgent = caption || `[Voice message: ${name}]`;
          resultForDb = caption || `🎤 ${name}`;
        } else {
          const transcriber = getTranscriber();
          if (transcriber) {
            const transcript = await transcriber(
              buffer,
              attachment.mimetype,
              attachment.filename,
            );
            resultForAgent = `[Voice message transcript]: ${transcript}`;
          } else {
            const name = attachment.filename || 'voice.ogg';
            resultForAgent = `[Audio message: ${name} — transcription not available]`;
          }
          resultForDb = resultForAgent;
        }
      } else if (
        attachment.mimetype.startsWith('image/') ||
        attachment.mimetype.startsWith('video/')
      ) {
        // Images/Videos: resultForAgent is handled below in the saveDir block.
        // For DB, we set a placeholder so the UI knows there is an attachment context.
        resultForDb = attachment.caption || '';
      } else {
        const docText = await extractDocumentText(
          buffer,
          attachment.mimetype,
          attachment.filename,
          attachment.caption,
        );
        resultForAgent = docText;
        resultForDb = docText;
      }

      // Save media to IPC so the agent container can access the actual file
      if (options?.saveDir && options?.containerPrefix) {
        try {
          fs.mkdirSync(options.saveDir, { recursive: true });
          const ext = extFromMimetype(attachment.mimetype);
          const safeName = (
            attachment.filename || `${attachment.type}.${ext}`
          ).replace(/[^a-zA-Z0-9._\-]/g, '_');
          const nameToStore = `${Date.now()}-${safeName}`;
          const pathToStore = path.join(options.saveDir, nameToStore);
          fs.writeFileSync(pathToStore, buffer);
          storedName = nameToStore;
          localPath = pathToStore;
          const containerPath = `${options.containerPrefix}/${storedName}`;
          if (
            attachment.mimetype.startsWith('image/') ||
            attachment.mimetype.startsWith('video/')
          ) {
            // Format: "- name: /path" under "[Attached files]" matches process.ts regex
            // and allows Web UI to hide the raw path
            const name =
              attachment.filename ||
              `${attachment.type}.${extFromMimetype(attachment.mimetype)}`;
            const block = `[Attached files]\n- ${name}: ${containerPath}`;
            resultForAgent = attachment.caption
              ? `${attachment.caption}\n\n${block}`
              : block;
            // Also add for DB (Web UI strips [Attached files] blocks natively)
            resultForDb = resultForDb ? `${resultForDb}\n\n${block}` : block;
          } else {
            resultForAgent += `\n[File saved at: ${containerPath}]`;
            resultForDb = resultForAgent;
          }
        } catch (saveErr) {
          logger.warn({ err: saveErr }, 'Failed to save media to IPC dir');
        }
      }

      agentParts.push(resultForAgent);
      if (resultForDb) {
        dbParts.push(resultForDb);
      }
    } catch (err) {
      logger.error(
        { url: attachment.url, type: attachment.type, err },
        'Failed to process media attachment',
      );
      const fallback = attachment.caption
        ? ` (caption: "${attachment.caption}")`
        : '';
      const errText = `[${attachment.type} attachment — processing failed${fallback}]`;
      agentParts.push(errText);
      dbParts.push(errText);
    }

    // Add to attachments list regardless of text extraction success/failure
    let finalUrl = attachment.url;
    if (options?.browserUrlPrefix && storedName) {
      finalUrl = `${options.browserUrlPrefix}/${storedName}`;
    }
    enrichedAttachments.push({
      type: attachment.type as any,
      url: finalUrl,
      mimetype: attachment.mimetype,
      filename: attachment.filename || undefined,
      caption: attachment.caption || undefined,
      path: localPath,
    });
  }

  return {
    forAgent: agentParts.join('\n\n'),
    forDb: dbParts.join('\n\n'),
    attachments: enrichedAttachments,
  };
}
