import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createMailRouter } from './mail.js';
import type { RegisteredGroup } from '../types.js';

function fixture(
  level: 'viewer' | 'editor' = 'editor',
  options: {
    token?: boolean;
    enabled?: boolean;
    receive?: boolean;
    send?: boolean;
    implicit?: boolean;
  } = {},
) {
  const call = mock(
    async (
      _project: string,
      tool: string,
      _args: any,
      _signal?: AbortSignal,
    ): Promise<any> => {
      if (tool === 'carapamail_list_accounts')
        return [
          {
            id: 'account-a',
            email: 'a@example.com',
            mcp_receive: options.receive !== false,
            mcp_send: options.send !== false,
          },
        ];
      if (tool === 'carapamail_list_folders')
        return [
          { name: 'Inbox', path: 'INBOX', total: 1, unseen: 1 },
          {
            name: 'Trash',
            path: 'Trash',
            specialUse: '\\Trash',
            total: 0,
            unseen: 0,
          },
        ];
      if (tool === 'carapamail_read_email')
        return {
          uid: 7,
          from: 'sender@example.com',
          to: 'a@example.com',
          subject: 'Hello',
          date: '',
          seen: false,
          attachment_count: 1,
          cc: '',
          body_text: '<script>untrusted</script>',
          attachments: [],
          rawHeaders: { secret: 'not exposed' },
          replyTo: 'reply@example.com',
          messageId: '<parent@example.com>',
          references: [],
        };
      if (tool === 'carapamail_download_attachment')
        return { url: 'http://mail/attachment', filename: 'document.txt' };
      if (tool === 'carapamail_search' || tool === 'carapamail_list_emails')
        return { items: [], total: 0, page: 1, totalPages: 1, hasMore: false };
      return {
        sent: true,
        message_id: '<sent@example.com>',
        moved: 1,
        updated: 1,
      };
    },
  );
  const download = mock(async () => Buffer.from('file'));
  const router = createMailRouter({
    getGroupByFolder: () =>
      ({
        folder: 'project-a',
        settings: {
          carapaMailEnabled: options.enabled !== false,
          carapaMailToken: options.token === false ? undefined : 'secret-token',
        },
      }) as RegisteredGroup,
    getProjectAccess: async () =>
      options.implicit ? { kind: 'implicit' } : { kind: 'explicit', level },
    call,
    download,
  });
  async function invoke(
    path: string,
    body?: unknown,
    query: Record<string, unknown> = {},
    authenticated = true,
  ) {
    const req: any = {
      authUser: authenticated ? { id: 'user-a', role: 'user' } : undefined,
      params: { pid: 'project-a', uid: '7' },
      query,
      body,
    };
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (name: string, value: string) => {
      res.headers[name] = value;
    };
    res.status = (status: number) => {
      res.statusCode = status;
      return res;
    };
    res.json = res.send = (data: unknown) => {
      res.body = data;
      return res;
    };
    res.attachment = res.type = () => res;
    const auth = router.stack.find((layer: any) => !layer.route)!.handle;
    let admitted = false;
    auth(req, res, () => {
      admitted = true;
    });
    if (admitted) {
      const layer = router.stack.find(
        (l: any) => l.route?.path === `/projects/:pid/mail/${path}`,
      )!;
      await layer.route!.stack[0].handle(req, res, (error?: unknown) => {
        if (error) throw error;
      });
    }
    return res;
  }
  return { call, download, invoke };
}

describe('project mail routes', () => {
  test('viewer reads are filtered and normalized; send, flags and moves are denied', async () => {
    const { invoke, call } = fixture('viewer');
    const detail = await invoke('messages/:uid', undefined, {
      account: 'account-a',
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body.bodyText).toBe('<script>untrusted</script>');
    expect(detail.body.replyTo).toBe('reply@example.com');
    expect(detail.body.rawHeaders).toBeUndefined();
    for (const [path, body] of [
      ['send', { to: 'b@example.com', subject: 'Hi', body: 'text' }],
      ['read-state', { uids: [7], seen: true }],
      ['move', { uids: [7], destination: 'Trash' }],
    ] as const) {
      expect(
        (await invoke(path, { account: 'account-a', ...body })).statusCode,
      ).toBe(403);
    }
    expect(
      call.mock.calls.filter((c) =>
        ['carapamail_send', 'carapamail_mark_read', 'carapamail_move'].includes(
          c[1],
        ),
      ),
    ).toHaveLength(0);
  });
  test('missing credentials, chat-only access, disabled mail, and foreign accounts cannot reach mail operations', async () => {
    expect(
      (await fixture().invoke('accounts', undefined, {}, false)).statusCode,
    ).toBe(401);
    expect(
      (await fixture('editor', { token: false }).invoke('accounts')).statusCode,
    ).toBe(409);
    expect(
      (await fixture('editor', { enabled: false }).invoke('accounts'))
        .statusCode,
    ).toBe(409);
    expect(
      (await fixture('editor', { implicit: true }).invoke('accounts'))
        .statusCode,
    ).toBe(403);
    const { invoke, call, download } = fixture();
    expect(
      (
        await invoke('messages/:uid', undefined, {
          account: 'other-project-account',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await invoke('attachment', undefined, {
          account: 'other-project-account',
          uid: 7,
          filename: 'file',
        })
      ).statusCode,
    ).toBe(403);
    expect(download).not.toHaveBeenCalled();
    expect(
      call.mock.calls.every(
        (c) => c[0] === 'project-a' && c[1] === 'carapamail_list_accounts',
      ),
    ).toBe(true);
  });
  test('account capabilities, search pagination, Trash moves, and threading are enforced', async () => {
    expect(
      (
        await fixture('editor', { send: false }).invoke('send', {
          account: 'account-a',
          to: 'b@example.com',
          subject: 'Hello',
          body: 'x',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await fixture('editor', { receive: false }).invoke('read-state', {
          account: 'account-a',
          uids: [7],
          seen: true,
        })
      ).statusCode,
    ).toBe(403);
    const { invoke, call } = fixture();
    await invoke('messages', undefined, {
      account: 'account-a',
      folder: 'INBOX',
      query: 'hello',
      page: '2',
    });
    expect(
      call.mock.calls.find((c) => c[1] === 'carapamail_search')?.[2],
    ).toMatchObject({ query: 'hello', page: 2, limit: 20 });
    const move = await invoke('move', {
      account: 'account-a',
      uids: [7],
      destination: 'Trash',
    });
    expect(move.statusCode).toBe(200);
    expect(call.mock.calls.some((c) => c[1] === 'carapamail_delete')).toBe(
      false,
    );
    expect(
      (
        await invoke('move', {
          account: 'account-a',
          uids: [7],
          destination: 'missing',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await invoke('send', {
          account: 'account-a',
          to: 'b@example.com',
          subject: 'Re: hello',
          body: 'reply',
          inReplyTo: '<parent@example.com>',
        })
      ).body,
    ).toEqual({ sent: true, messageId: '<sent@example.com>' });
    expect(
      (
        await invoke('send', {
          account: 'account-a',
          to: 'b@example.com',
          subject: 'Hello',
          body: 'reply',
          inReplyTo: '<id@example.com>\r\nBcc: other@example.com',
        })
      ).statusCode,
    ).toBe(400);
  });
  test('MCP filter and transport errors return failures and are never retried', async () => {
    const { invoke, call } = fixture();
    call.mockImplementation(async () => {
      throw new Error('Blocked by mail filter');
    });
    const response = await invoke('accounts');
    expect(response.statusCode).toBe(502);
    expect(response.body.error).toBe('Blocked by mail filter');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
