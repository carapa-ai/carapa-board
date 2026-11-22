import fs from 'node:fs';
import path from 'node:path';

import {
  SECURITY_DEVICE,
  SECURITY_FOLDER,
  SECURITY_LINKS,
  SECURITY_SECRET,
} from './security-fixtures.js';
import { SANDBOX_DIRECT_RUNTIME } from './shared.js';

/**
 * Symlink and attachment-path checks of the security smoke, against the real
 * app: ART-ROOT-1 (a symlinked group `artifacts` folder), GFS-5 (objective,
 * dashboard and project file routes) and ATT-PATH-1 (chat attachment paths).
 * The expected statuses are the ones the route code returns today; the
 * secret must never appear in a response body or in a model request.
 */
type Check = (condition: boolean, message: string) => void;

/** Signs a request like the SPA does (see fresh-signature.ts). */
async function signHeaders(
  key: CryptoKey,
  method: string,
  urlPath: string,
  body: string,
): Promise<Record<string, string>> {
  const timestamp = new Date().toISOString();
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${timestamp}:${method}:${urlPath}:${body}`),
  );
  return {
    'x-carapa-device-id': SECURITY_DEVICE.id,
    'x-carapa-timestamp': timestamp,
    'x-carapa-signature': Buffer.from(signature).toString('base64'),
  };
}

const SECRET_BASE64 = Buffer.from(SECURITY_SECRET).toString('base64');

export async function runSymlinkChecks(
  env: { apiUrl: string; authCookie: string; root: string; llmUrl: string },
  check: Check,
): Promise<void> {
  const { apiUrl, authCookie, root, llmUrl } = env;
  const L = SECURITY_LINKS;
  // The module routers (objective files) sit behind the fresh-signature gate.
  const deviceKey = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(
      fs.readFileSync(path.join(root, SECURITY_DEVICE.keyFile), 'utf8'),
    ),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const api = async (
    method: string,
    urlPath: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const response = await fetch(`${apiUrl}${urlPath}`, {
      method,
      headers: {
        Cookie: authCookie,
        ...(await signHeaders(deviceKey, method, urlPath, payload)),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : payload,
      redirect: 'manual',
    });
    const text = await response.text();
    check(
      !text.includes(SECURITY_SECRET),
      `${method} ${urlPath}: response leaked the outside-the-dir secret`,
    );
    return { status: response.status, text };
  };
  const expectStatus = async (
    label: string,
    expected: number,
    method: string,
    urlPath: string,
    body?: unknown,
  ) => {
    const res = await api(method, urlPath, body);
    check(
      res.status === expected,
      `${label}: expected ${expected}, got ${res.status}`,
    );
    return res;
  };

  // ART-ROOT-1: `groups/<artifactsGroup>/artifacts` is a link to a directory
  // holding the secret, so nothing below it is served, listed or touched.
  const artifacts = `/artifacts/${L.artifactsGroup}`;
  await expectStatus(
    'ART-ROOT-1 GET file',
    404,
    'GET',
    `${artifacts}/leak.txt`,
  );
  await expectStatus(
    'ART-ROOT-1 GET file in topic',
    404,
    'GET',
    `${artifacts}/docs/leak.txt`,
  );
  const target = path.join(root, L.artifactsTarget);
  await expectStatus(
    'ART-ROOT-1 DELETE artifact',
    404,
    'DELETE',
    `/api/projects/${L.artifactsGroup}/artifacts/leak.txt`,
  );
  check(
    fs.existsSync(path.join(target, 'leak.txt')),
    'ART-ROOT-1 DELETE artifact: removed a file through the symlinked root',
  );
  // The upload route persists a copy into artifacts/upload/<conversation>/
  // best-effort; with a symlinked root it must write nothing there.
  const foreign = await expectStatus(
    'ATT-PATH-1 upload to the other project',
    200,
    'POST',
    `/api/projects/${L.artifactsGroup}/upload`,
    {
      filename: 'foreign.png',
      mimetype: 'image/png',
      conversation_id: 'ui-security-art-root',
      data: Buffer.from(SECURITY_SECRET).toString('base64'),
    },
  );
  check(
    !fs.existsSync(path.join(target, 'upload')),
    'ART-ROOT-1 artifact write: upload wrote through the symlinked root',
  );

  // GFS-5: objective files, dashboard static files and project files.
  const objective = `/api/projects/${L.objectiveGroup}/objectives/${L.objectiveId}`;
  await expectStatus(
    'GFS-5 objective file symlink',
    400,
    'GET',
    `${objective}/files/rules/link.md`,
  );
  await expectStatus(
    'GFS-5 objective folder symlink',
    400,
    'GET',
    `${objective}/files/prompts/leak.md`,
  );
  const listing = await expectStatus(
    'GFS-5 objective folder symlink listing',
    200,
    'GET',
    `${objective}/files?folder=prompts`,
  );
  check(
    !listing.text.includes('leak.md'),
    'GFS-5 objective folder symlink listing: listed a file of the link target',
  );
  await expectStatus(
    'GFS-5 dashboard file symlink',
    400,
    'GET',
    `${objective}/dashboard/link.txt`,
  );
  await expectStatus(
    'GFS-5 dashboard folder symlink',
    400,
    'GET',
    `${objective}/dashboard/linkdir/leak.md`,
  );
  const project = `/api/projects/${L.projectGroup}/files`;
  for (const [label, rel] of [
    ['file symlink', 'link-out.txt'],
    ['folder symlink', 'linkdir/leak.md'],
  ] as const) {
    await expectStatus(
      `GFS-5 project content ${label}`,
      400,
      'GET',
      `${project}/group/content?path=${rel}`,
    );
  }
  const dirListing = await api('GET', `${project}/group?path=linkdir`);
  check(
    !dirListing.text.includes('leak.md'),
    'GFS-5 project folder symlink listing: listed a file of the link target',
  );

  // ATT-PATH-1: only files uploaded to this project keep their `path`. The
  // simulator completes requests by itself so every message reaches it.
  const autoRelease = (enabled: boolean) =>
    fetch(`${llmUrl}/auto-release`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  await autoRelease(true);
  const simulator = async (): Promise<string[]> =>
    ((await (await fetch(`${llmUrl}/requests`)).json()) as unknown[]).map(
      (request) => JSON.stringify(request),
    );
  const upload = await api('POST', `/api/projects/${SECURITY_FOLDER}/upload`, {
    filename: 'control.png',
    data: Buffer.from(L.controlBytes).toString('base64'),
  });
  const controlPath = JSON.parse(upload.text).absolutePath as string;
  const foreignPath = JSON.parse(foreign.text).absolutePath as string;
  const post = async (label: string, attachmentPath: string) => {
    const before = (await simulator()).length;
    const res = await api('POST', `/api/projects/${SECURITY_FOLDER}/messages`, {
      content: `Attachment path check: ${label}`,
      runtimeSelection: SANDBOX_DIRECT_RUNTIME,
      attachments: [
        { type: 'image', mimetype: 'image/png', path: attachmentPath },
      ],
    });
    const deadline = Date.now() + 15_000;
    let requests = await simulator();
    while (requests.length === before && Date.now() < deadline) {
      await Bun.sleep(100);
      requests = await simulator();
    }
    return { res, reached: requests.slice(before) };
  };

  const control = await post('own upload', controlPath);
  check(
    control.res.status === 202,
    `ATT-PATH-1 control: expected 202, got ${control.res.status}`,
  );
  const controlBase64 = Buffer.from(L.controlBytes).toString('base64');
  check(
    control.reached.some((body) => body.includes(controlBase64)),
    'ATT-PATH-1 control: the own upload did not reach the model request ' +
      JSON.stringify(control.reached).slice(0, 1500),
  );
  for (const [label, attachmentPath] of [
    [
      'absolute path of the secret file',
      path.join(root, 'security-outside-secret.txt'),
    ],
    ['upload of another project', foreignPath],
  ] as const) {
    const { res, reached } = await post(label, attachmentPath);
    check(
      res.status === 202,
      `ATT-PATH-1 ${label}: expected 202, got ${res.status}`,
    );
    check(
      reached.length > 0,
      `ATT-PATH-1 ${label}: the message never reached the model`,
    );
    const stored = JSON.parse(res.text).userMessage?.attachments ?? [];
    check(
      stored.length === 1 && stored[0].path === undefined,
      `ATT-PATH-1 ${label}: the stored message keeps the attachment path`,
    );
    check(
      reached.every(
        (body) =>
          !body.includes(SECURITY_SECRET) && !body.includes(SECRET_BASE64),
      ),
      `ATT-PATH-1 ${label}: file bytes reached the model request`,
    );
  }
  await autoRelease(false);
}
