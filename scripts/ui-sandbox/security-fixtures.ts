import fs from 'node:fs';
import path from 'node:path';

/**
 * Fixtures for the `security` smoke scenario (security-smoke.ts). This module
 * is deliberately free of `src/` imports so both the seeder and the smoke
 * script can share it.
 */
export const SECURITY_FOLDER = 'ui-chat';
export const SECURITY_CONVERSATION_ID = 'ui-security-share';
export const SECURITY_MESSAGE_ID = 'ui-security-share-message';
/** File in the sandbox root that carries the seeded public share token. */
export const SECURITY_SHARE_TOKEN_FILE = 'security-share-token.txt';
/** Content of every file that must never be served; asserted absent. */
export const SECURITY_SECRET = 'UI-SANDBOX-SECURITY-SECRET-MUST-NOT-LEAK';

/** Attachment URLs of the shared message; the array index is the route index. */
export const SECURITY_SHARE_ATTACHMENTS = [
  `/artifacts/${SECURITY_FOLDER}/docs/ok.txt`,
  `/artifacts/${SECURITY_FOLDER}/docs/../../../secret.txt`,
  `/uploads/${SECURITY_FOLDER}/ok.txt`,
  `/uploads/${SECURITY_FOLDER}/link.txt`,
  `/uploads/${SECURITY_FOLDER}/page.html`,
  `/uploads/other-folder/ok.txt`,
  `/artifacts/${SECURITY_FOLDER}/docs/page.html`,
  // Stays inside the artifacts tree, so only the `..` segment check (not
  // containment) rejects it.
  `/artifacts/${SECURITY_FOLDER}/docs/../docs/ok.txt`,
] as const;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const HTML = '<!doctype html><title>x</title><script>1</script>\n';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>1</script></svg>\n';

/**
 * Writes the upload and artifact files, the outside-the-dir secrets and the
 * upload symlink. Everything lives under the sandbox root: `groupDir` is
 * `<root>/groups/<folder>` and the upload dir is `<root>/data/ipc/...`.
 */
export function writeSecurityFiles(
  uploadDir: string,
  groupDir: string,
  root: string,
): void {
  fs.mkdirSync(uploadDir, { recursive: true });
  const outsideSecret = path.join(root, 'security-outside-secret.txt');
  fs.writeFileSync(outsideSecret, SECURITY_SECRET);
  fs.writeFileSync(path.join(uploadDir, 'ok.txt'), 'upload ok');
  fs.writeFileSync(path.join(uploadDir, 'page.html'), HTML);
  fs.writeFileSync(path.join(uploadDir, 'pic.svg'), SVG);
  fs.writeFileSync(path.join(uploadDir, 'real.png'), PNG);
  fs.writeFileSync(path.join(uploadDir, 'real.pdf'), PDF);
  fs.rmSync(path.join(uploadDir, 'link.txt'), { force: true });
  fs.symlinkSync(outsideSecret, path.join(uploadDir, 'link.txt'));

  const docs = path.join(groupDir, 'artifacts', 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'ok.txt'), 'artifact ok');
  fs.writeFileSync(path.join(docs, 'page.html'), HTML);
  fs.writeFileSync(path.join(docs, 'pic.svg'), SVG);
  fs.writeFileSync(path.join(docs, 'real.pdf'), PDF);
  fs.writeFileSync(path.join(docs, 'real.png'), PNG);
  // Target of the `docs/../../../secret.txt` traversal attachment.
  fs.writeFileSync(path.join(groupDir, '..', 'secret.txt'), SECURITY_SECRET);
}

/**
 * Projects and tasks for the MCP-reach checks (security-mcp.ts). The member
 * user is added to `memberProject` by the smoke; nobody but the admin can
 * reach `privateProject`. Each task title is unique so a leak is detectable
 * in a response body.
 */
export const SECURITY_MCP = {
  memberProject: 'ui-running',
  privateProject: 'ui-paused',
  memberTask: {
    id: 'ui-security-mcp-member-task',
    title: 'MCP reach fixture in the member project',
  },
  privateTask: {
    id: 'ui-security-mcp-private-task',
    title: 'MCP reach fixture in the private project',
  },
} as const;

/**
 * Symlink fixtures for the ART-ROOT-1, GFS-5 and ATT-PATH-1 checks
 * (security-symlinks.ts). Each group is an existing seeded project; the
 * symlink targets live in the sandbox root, outside every served directory.
 */
export const SECURITY_LINKS = {
  /** Group whose `artifacts` folder is a symlink to `artifactsTarget`. */
  artifactsGroup: 'ui-stopped',
  artifactsTarget: 'security-artifacts-root-target',
  /** Group and objective that hold the objective-folder symlinks. */
  objectiveGroup: 'ui-objectives',
  objectiveId: 'ui-objective-active',
  /** Group that holds the project-file symlinks. */
  projectGroup: 'ui-task-steering',
  /** Directory outside the groups that the directory symlinks point at. */
  outsideDir: 'security-outside-dir',
  /** Bytes of a legitimate upload; they must reach the model request. */
  controlBytes: 'UI-SANDBOX-ATTACHMENT-CONTROL-BYTES',
} as const;

/**
 * Device of the admin the seeder registers (approved) for the routes behind
 * the fresh-signature gate, e.g. the objective file routes. The private JWK
 * is written to this file in the sandbox root.
 */
export const SECURITY_DEVICE = {
  id: 'ui-security-device',
  keyFile: 'security-device-key.json',
} as const;

function plantLink(target: string, linkPath: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(target, linkPath);
}

/**
 * Plants the symlinks. `groupsDir` is `<root>/groups`; everything lives
 * under `root`, the disposable sandbox root.
 */
export function writeSecuritySymlinkFiles(
  root: string,
  groupsDir: string,
): void {
  const {
    artifactsGroup,
    artifactsTarget,
    objectiveGroup,
    objectiveId,
    projectGroup,
    outsideDir,
  } = SECURITY_LINKS;
  const secretFile = path.join(root, 'security-outside-secret.txt');

  // ART-ROOT-1: the whole artifacts folder is a link to a directory that
  // holds the secret.
  const target = path.join(root, artifactsTarget);
  fs.mkdirSync(path.join(target, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(target, 'leak.txt'), SECURITY_SECRET);
  fs.writeFileSync(path.join(target, 'docs', 'leak.txt'), SECURITY_SECRET);
  plantLink(target, path.join(groupsDir, artifactsGroup, 'artifacts'));

  // GFS-5: a file link and a directory link that leave the group.
  const outside = path.join(root, outsideDir);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'leak.md'), SECURITY_SECRET);
  const objective = path.join(
    groupsDir,
    objectiveGroup,
    'objectives',
    objectiveId,
  );
  plantLink(secretFile, path.join(objective, '.agent', 'rules', 'link.md'));
  plantLink(outside, path.join(objective, '.agent', 'prompts'));
  plantLink(secretFile, path.join(objective, 'dashboard', 'link.txt'));
  plantLink(outside, path.join(objective, 'dashboard', 'linkdir'));
  plantLink(secretFile, path.join(groupsDir, projectGroup, 'link-out.txt'));
  plantLink(outside, path.join(groupsDir, projectGroup, 'linkdir'));
}
