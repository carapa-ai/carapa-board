import { z } from 'zod';
import type {
  MailAccount,
  MailFolder,
  MailMessage,
  MailMessageDetail,
  MailPage,
} from '../../types.js';
import { CARAPA_MAIL_BASE_URL, callCarapaMailJson } from './client.js';

export class MailHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function mailRole(
  user: { id: string; role: string },
  group: { is_main?: boolean; user_id?: string | null },
  access: { kind: string; level?: string } | null,
): 'viewer' | 'editor' {
  if (group.is_main && group.user_id !== user.id)
    throw new MailHttpError(403, 'Access denied to this project');
  // An admin on a project owned by another user has only their membership.
  if (user.role === 'admin' && (!group.user_id || group.user_id === user.id))
    return 'editor';
  if (access?.kind !== 'explicit')
    throw new MailHttpError(403, 'Explicit project membership is required');
  return access.level === 'owner' || access.level === 'editor'
    ? 'editor'
    : 'viewer';
}

function parseMailPayload<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new MailHttpError(502, 'CarapaMail returned an invalid response');
  return parsed.data;
}
export function normalizeMailFolders(raw: unknown): MailFolder[] {
  return parseMailPayload(
    z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        total: z.number(),
        unseen: z.number(),
        specialUse: z.string().optional(),
      }),
    ),
    raw,
  );
}
export function normalizeMailSent(raw: unknown): {
  sent: true;
  messageId: string;
} {
  const sent = parseMailPayload(
    z.object({ sent: z.literal(true), message_id: z.string() }),
    raw,
  );
  return { sent: sent.sent, messageId: sent.message_id };
}

export type MailCall = typeof callCarapaMailJson;
const wireAccounts = z.array(
  z.object({
    id: z.string(),
    email: z.string(),
    mcp_receive: z.boolean(),
    mcp_send: z.boolean(),
  }),
);
export async function mailAccounts(
  projectId: string,
  editable: boolean,
  call: MailCall = callCarapaMailJson,
): Promise<MailAccount[]> {
  const accounts = parseMailPayload(
    wireAccounts,
    await call(projectId, 'carapamail_list_accounts', {}),
  );
  return accounts.map((a) => ({
    id: a.id,
    email: a.email,
    capabilities: {
      read: a.mcp_receive,
      send: editable && a.mcp_send,
      organize: editable && a.mcp_receive,
    },
  }));
}
export async function requireMailAccount(
  projectId: string,
  accountId: string,
  editable: boolean,
  capability: 'read' | 'send' | 'organize',
  call: MailCall = callCarapaMailJson,
): Promise<MailAccount> {
  const account = (await mailAccounts(projectId, editable, call)).find(
    (a) => a.id === accountId,
  );
  if (!account?.capabilities[capability])
    throw new MailHttpError(
      403,
      'This account does not permit that mail operation',
    );
  return account;
}
const wireMessage = z.object({
  uid: z.number(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  date: z.string(),
  seen: z.boolean(),
  attachment_count: z.number().optional().default(0),
});
function normalizeMailMessage(raw: unknown): MailMessage {
  const { attachment_count, ...rest } = parseMailPayload(wireMessage, raw);
  return { ...rest, attachmentCount: attachment_count };
}
export function normalizeMailPage(raw: unknown): MailPage {
  const schema = z.object({
    items: z.array(wireMessage),
    total: z.number(),
    page: z.number(),
    totalPages: z.number(),
    hasMore: z.boolean(),
  });
  const page = parseMailPayload(schema, raw);
  return { ...page, items: page.items.map(normalizeMailMessage) };
}
export function normalizeMailDetail(raw: unknown): MailMessageDetail {
  const schema = wireMessage.extend({
    cc: z.string(),
    body_text: z.string(),
    replyTo: z.string().optional().default(''),
    messageId: z.string().optional().default(''),
    references: z.array(z.string()).optional().default([]),
    attachments: z.array(
      z.object({ name: z.string(), type: z.string(), size: z.number() }),
    ),
  });
  const detail = parseMailPayload(schema, raw);
  return {
    ...normalizeMailMessage(detail),
    cc: detail.cc,
    bodyText: detail.body_text,
    replyTo: detail.replyTo,
    messageId: detail.messageId,
    references: detail.references,
    attachments: detail.attachments,
  };
}
export const MAX_MAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export async function downloadMailAttachment(
  url: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const target = new URL(url);
  if (
    target.origin !== new URL(CARAPA_MAIL_BASE_URL).origin ||
    target.username ||
    target.password
  )
    throw new MailHttpError(502, 'Invalid mail attachment URL');
  const response = await fetcher(target, { signal, redirect: 'error' });
  if (!response.ok || !response.body)
    throw new MailHttpError(502, 'Could not download attachment');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (
      Number(response.headers.get('content-length')) > MAX_MAIL_ATTACHMENT_BYTES
    )
      throw new MailHttpError(413, 'Attachment exceeds the 25 MB limit');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MAIL_ATTACHMENT_BYTES)
        throw new MailHttpError(413, 'Attachment exceeds the 25 MB limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
