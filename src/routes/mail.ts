import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getProjectAccess } from '../modules/knowledge/db-kb.js';
import { getGroupByFolder } from '../state-manager.js';
import { callCarapaMailJson } from '../modules/mail/client.js';
import {
  downloadMailAttachment,
  MailHttpError,
  mailAccounts,
  mailRole,
  normalizeMailDetail,
  normalizeMailFolders,
  normalizeMailSent,
  normalizeMailPage,
  requireMailAccount,
} from '../modules/mail/service.js';
import { requireAuth } from './auth-helpers.js';
import type { MailFolder } from '../types.js';

const targetSchema = z.object({
  account: z.string().min(1),
  folder: z.string().min(1).default('INBOX'),
});
const uidsSchema = z.array(z.number().int().positive()).min(1).max(100);
const messageId = z
  .string()
  .max(998)
  .regex(/^<[^<>\s]+@[^<>\s]+>$/);
const draftSchema = targetSchema.omit({ folder: true }).extend({
  to: z.email(),
  subject: z
    .string()
    .max(998)
    .regex(/^[^\r\n]*$/),
  body: z.string().max(1_000_000),
  inReplyTo: messageId.optional(),
  references: z.array(messageId).max(100).optional(),
});
export function createMailRouter(
  deps = {
    getGroupByFolder,
    getProjectAccess,
    call: callCarapaMailJson,
    download: downloadMailAttachment,
  },
) {
  const router = Router();
  type Handler = (
    req: Request,
    res: Response,
    context: {
      projectId: string;
      editable: boolean;
      signal: AbortSignal;
      call: typeof callCarapaMailJson;
    },
  ) => Promise<unknown>;
  function route(handler: Handler) {
    return async (req: any, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const abort = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.on('close', disconnect);
      const timeout = setTimeout(() => abort.abort(), 125_000);
      try {
        const projectId = req.params.pid;
        const group = deps.getGroupByFolder(projectId);
        if (!group) throw new MailHttpError(404, 'Project not found');
        const role = mailRole(
          req.authUser,
          group,
          await deps.getProjectAccess(req.authUser.id, projectId),
        );
        if (!group.settings?.carapaMailEnabled)
          throw new MailHttpError(409, 'Mail is disabled for this project');
        if (!group.settings.carapaMailToken)
          throw new MailHttpError(
            409,
            'Add a CarapaMail token in project settings',
          );
        return await handler(req, res, {
          projectId,
          editable: role === 'editor',
          signal: abort.signal,
          call: (project, name, args) =>
            deps.call(project, name, args, abort.signal),
        });
      } catch (error) {
        if (res.headersSent || res.destroyed) return;
        const status =
          error instanceof MailHttpError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : abort.signal.aborted
                ? 504
                : 502;
        res.status(status).json({
          error:
            error instanceof z.ZodError
              ? 'Invalid mail request or response'
              : error instanceof Error
                ? error.message
                : 'Mail request failed',
        });
      } finally {
        clearTimeout(timeout);
        res.off('close', disconnect);
      }
    };
  }
  router.use('/projects/:pid/mail', requireAuth);
  router.get(
    '/projects/:pid/mail/accounts',
    route(async (_req, res, ctx) => {
      res.json({
        accounts: await mailAccounts(ctx.projectId, ctx.editable, ctx.call),
      });
    }),
  );
  router.get(
    '/projects/:pid/mail/folders',
    route(async (req, res, ctx) => {
      const { account } = targetSchema.parse(req.query);
      await requireMailAccount(
        ctx.projectId,
        account,
        ctx.editable,
        'read',
        ctx.call,
      );
      res.json(
        normalizeMailFolders(
          await ctx.call(
            ctx.projectId,
            'carapamail_list_folders',
            { account },
            ctx.signal,
          ),
        ),
      );
    }),
  );
  router.get(
    '/projects/:pid/mail/messages',
    route(async (req, res, ctx) => {
      const args = targetSchema
        .extend({
          page: z.coerce.number().int().positive().default(1),
          query: z.string().max(1000).optional(),
        })
        .parse(req.query);
      await requireMailAccount(
        ctx.projectId,
        args.account,
        ctx.editable,
        'read',
        ctx.call,
      );
      res.json(
        normalizeMailPage(
          await ctx.call(
            ctx.projectId,
            args.query ? 'carapamail_search' : 'carapamail_list_emails',
            { ...args, limit: 20 },
            ctx.signal,
          ),
        ),
      );
    }),
  );
  router.get(
    '/projects/:pid/mail/messages/:uid',
    route(async (req, res, ctx) => {
      const args = {
        ...targetSchema.parse(req.query),
        uid: z.coerce.number().int().positive().parse(req.params.uid),
      };
      await requireMailAccount(
        ctx.projectId,
        args.account,
        ctx.editable,
        'read',
        ctx.call,
      );
      res.json(
        normalizeMailDetail(
          await ctx.call(
            ctx.projectId,
            'carapamail_read_email',
            args,
            ctx.signal,
          ),
        ),
      );
    }),
  );
  router.get(
    '/projects/:pid/mail/attachment',
    route(async (req, res, ctx) => {
      const args = targetSchema
        .extend({
          uid: z.coerce.number().int().positive(),
          filename: z.string().min(1),
        })
        .parse(req.query);
      await requireMailAccount(
        ctx.projectId,
        args.account,
        ctx.editable,
        'read',
        ctx.call,
      );
      const meta = await ctx.call<{ url: string; filename: string }>(
        ctx.projectId,
        'carapamail_download_attachment',
        args,
        ctx.signal,
      );
      const bytes = await deps.download(meta.url, ctx.signal);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res
        .attachment(meta.filename || args.filename)
        .type('application/octet-stream')
        .send(bytes);
    }),
  );
  router.post(
    '/projects/:pid/mail/send',
    route(async (req, res, ctx) => {
      const args = draftSchema.parse(req.body);
      await requireMailAccount(
        ctx.projectId,
        args.account,
        ctx.editable,
        'send',
        ctx.call,
      );
      const sent = await ctx.call<{ sent: boolean; message_id: string }>(
        ctx.projectId,
        'carapamail_send',
        args,
        ctx.signal,
      );
      res.json(normalizeMailSent(sent));
    }),
  );
  router.post(
    '/projects/:pid/mail/read-state',
    route(async (req, res, ctx) => {
      const args = targetSchema
        .extend({ uids: uidsSchema, seen: z.boolean() })
        .parse(req.body);
      await requireMailAccount(
        ctx.projectId,
        args.account,
        ctx.editable,
        'organize',
        ctx.call,
      );
      res.json(
        await ctx.call(ctx.projectId, 'carapamail_mark_read', args, ctx.signal),
      );
    }),
  );
  router.post(
    '/projects/:pid/mail/move',
    route(async (req, res, ctx) => {
      const args = targetSchema
        .extend({ uids: uidsSchema, destination: z.string().min(1) })
        .parse(req.body);
      await requireMailAccount(
        ctx.projectId,
        args.account,
        ctx.editable,
        'organize',
        ctx.call,
      );
      if (args.folder === args.destination)
        throw new MailHttpError(400, 'Choose a different destination folder');
      const folders = normalizeMailFolders(
        await ctx.call<MailFolder[]>(
          ctx.projectId,
          'carapamail_list_folders',
          { account: args.account },
          ctx.signal,
        ),
      );
      if (!folders.some((f) => f.path === args.destination))
        throw new MailHttpError(400, 'Destination folder not found');
      res.json(
        await ctx.call(ctx.projectId, 'carapamail_move', args, ctx.signal),
      );
    }),
  );
  return router;
}
export default createMailRouter();
