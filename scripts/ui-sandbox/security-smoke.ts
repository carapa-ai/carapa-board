import fs from 'node:fs';
import path from 'node:path';

import {
  SECURITY_FOLDER,
  SECURITY_MESSAGE_ID,
  SECURITY_SECRET,
  SECURITY_SHARE_ATTACHMENTS,
  SECURITY_SHARE_TOKEN_FILE,
} from './security-fixtures.js';
import { runMcpReachChecks } from './security-mcp.js';
import { runSymlinkChecks } from './security-symlinks.js';

/**
 * Behaviour check of the routes that serve user/agent-written files, run
 * against the real app of the disposable UI sandbox: /uploads, /artifacts and
 * the public share attachment route, plus what a logged-in human can reach
 * over /mcp (security-mcp.ts) and the symlink and attachment-path refusals
 * (security-symlinks.ts). Local sandbox verification only.
 */
const apiUrl = process.env.UI_SANDBOX_API_URL;
const authCookie = process.env.UI_SANDBOX_AUTH_COOKIE;
const root = process.env.UI_SANDBOX_ROOT;
const llmUrl = process.env.UI_SANDBOX_LLM_CONTROL_URL;

if (!apiUrl || !authCookie || !root || !llmUrl) {
  throw new Error('Security smoke environment is incomplete');
}

const failures: string[] = [];
let checks = 0;

function check(condition: boolean, message: string): void {
  checks += 1;
  if (!condition) failures.push(message);
}

interface Fetched {
  status: number;
  headers: Headers;
  body: string;
}

async function get(urlPath: string, authenticated: boolean): Promise<Fetched> {
  const response = await fetch(`${apiUrl}${urlPath}`, {
    headers: authenticated ? { Cookie: authCookie! } : {},
    redirect: 'manual',
  });
  const body = await response.text();
  check(
    !body.includes(SECURITY_SECRET),
    `${urlPath}: response leaked the outside-the-dir secret`,
  );
  return { status: response.status, headers: response.headers, body };
}

function disposition(res: Fetched): string {
  return res.headers.get('content-disposition') ?? '';
}

function expectPlain(label: string, res: Fetched): void {
  check(res.status === 200, `${label}: expected 200, got ${res.status}`);
  check(
    res.headers.get('x-content-type-options') === 'nosniff',
    `${label}: missing x-content-type-options: nosniff`,
  );
  check(
    !disposition(res).includes('attachment'),
    `${label}: must not be served as attachment (${disposition(res)})`,
  );
}

function expectActive(label: string, res: Fetched): void {
  check(res.status === 200, `${label}: expected 200, got ${res.status}`);
  check(
    res.headers.get('x-content-type-options') === 'nosniff',
    `${label}: missing x-content-type-options: nosniff`,
  );
  check(
    (res.headers.get('content-security-policy') ?? '').includes('sandbox'),
    `${label}: content-security-policy lacks sandbox`,
  );
  check(
    disposition(res).startsWith('attachment'),
    `${label}: content-disposition must start with attachment (${disposition(res)})`,
  );
}

const uploads = `/uploads/${SECURITY_FOLDER}`;
const artifacts = `/artifacts/${SECURITY_FOLDER}/docs`;

for (const [base, label] of [
  [uploads, '/uploads'],
  [artifacts, '/artifacts'],
] as const) {
  expectPlain(`${label} real.png`, await get(`${base}/real.png`, true));
  expectPlain(`${label} real.pdf`, await get(`${base}/real.pdf`, true));
  expectActive(`${label} page.html`, await get(`${base}/page.html`, true));
  expectActive(`${label} pic.svg`, await get(`${base}/pic.svg`, true));
}

const symlink = await get(`${uploads}/link.txt`, true);
check(
  symlink.status === 404,
  `/uploads symlink: expected 404, got ${symlink.status}`,
);

for (const urlPath of [`${uploads}/real.png`, `${artifacts}/real.png`]) {
  const res = await get(urlPath, false);
  check(
    res.status === 401 || res.status === 403,
    `unauthenticated ${urlPath}: expected 401/403, got ${res.status}`,
  );
}

// Public share: the token was seeded into the sandbox root; the attachment
// route itself needs no login.
const token = fs
  .readFileSync(path.join(root, SECURITY_SHARE_TOKEN_FILE), 'utf8')
  .trim();
if (!token) throw new Error('Seeded public share token is empty');

const shared = (urlPath: string) => {
  const index = SECURITY_SHARE_ATTACHMENTS.indexOf(
    urlPath as (typeof SECURITY_SHARE_ATTACHMENTS)[number],
  );
  if (index < 0) throw new Error(`Unknown share attachment ${urlPath}`);
  return get(
    `/api/public/conversations/${token}/attachments/${SECURITY_MESSAGE_ID}/${index}`,
    false,
  );
};

for (const [urlPath, text] of [
  [`/artifacts/${SECURITY_FOLDER}/docs/ok.txt`, 'artifact ok'],
  [`/uploads/${SECURITY_FOLDER}/ok.txt`, 'upload ok'],
] as const) {
  const res = await shared(urlPath);
  check(
    res.status === 200,
    `share ${urlPath}: expected 200, got ${res.status}`,
  );
  check(res.body === text, `share ${urlPath}: unexpected body`);
}
for (const urlPath of [
  `/artifacts/${SECURITY_FOLDER}/docs/../../../secret.txt`,
  `/artifacts/${SECURITY_FOLDER}/docs/../docs/ok.txt`,
  `/uploads/${SECURITY_FOLDER}/link.txt`,
  `/uploads/other-folder/ok.txt`,
] as const) {
  const res = await shared(urlPath);
  check(
    res.status === 404,
    `share ${urlPath}: expected 404, got ${res.status}`,
  );
}
expectActive(
  'share upload page.html',
  await shared(`/uploads/${SECURITY_FOLDER}/page.html`),
);
expectActive(
  'share artifact page.html',
  await shared(`/artifacts/${SECURITY_FOLDER}/docs/page.html`),
);

await runMcpReachChecks(apiUrl, check);
await runSymlinkChecks({ apiUrl, authCookie, root, llmUrl }, check);

if (failures.length > 0) {
  console.error(`Security smoke failed (${failures.length}/${checks} checks):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`Security UI sandbox smoke test passed (${checks} checks).`);
