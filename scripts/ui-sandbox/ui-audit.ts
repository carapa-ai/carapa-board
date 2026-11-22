/**
 * Reusable mechanical UI audit (`bun run ui:audit -- --views <file> ...`).
 *
 * Drives the signed-in sandbox browser through `playwright-cli run-code` and
 * measures every view x viewport: horizontal overflow, clipped/off-viewport
 * elements, truncated text, tap targets (<24px all, <44px primary on touch-sized viewports), overlapping
 * text boxes, text contrast and focus-ring contrast from computed colours,
 * focus-ring presence per control, focus trap and Escape. Writes
 * `audit-<label>.json` and `audit-<label>-summary.txt`. The browser-side
 * measurements live in `ui-audit-page.js`. See scripts/ui-sandbox/README.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AuditViewport {
  name: string;
  w: number;
  h: number;
  mobile: boolean;
}

export interface AuditStep {
  click?: string;
  clickAll?: string;
  fill?: [string, string];
  select?: [string, string];
  check?: string;
  press?: string;
  hover?: string;
  focus?: string;
  scrollIntoView?: string;
  waitFor?: string;
  wait?: number;
  then?: number;
  /** Skip this step when the selector is already visible (open a toggle once). */
  unless?: string;
}

export interface PatchRule {
  match?: Record<string, unknown>;
  set: Record<string, unknown>;
}

export interface AuditMock {
  /** Substring of the request pathname. */
  url: string;
  method?: string;
  status?: number;
  json?: unknown;
  delayMs?: number;
  /** Patch the real response instead of replacing it: dotted-path `set` on every object (any depth) whose fields equal `match`. */
  patch?: PatchRule | PatchRule[];
}

export interface AuditView {
  name: string;
  /** Path (with query) opened before the steps; default `/`. */
  route?: string;
  /** Selector awaited after navigation. */
  ready?: string;
  /** Request mocks for loading, empty and error states. */
  mocks?: AuditMock[];
  /** WebSocket pushes: messages sent when a socket whose path contains `url` opens. */
  wsMocks?: Array<{ url: string; send: unknown[] }>;
  /** Header-row metric: rows, lone-control rows and height of the region `scope`, ended by the first visible `until`. */
  rows?: { scope: string; until?: string };
  /** Toolbar insets in a pane: `pane` root and `toolbar` element (first row measured). */
  toolbar?: { pane: string; toolbar: string };
  /** Field/button pairs: heights of every button beside a field in `scope` (default the page). */
  pairs?: { scope?: string };
  /** Setup steps: open the bell, open notification X, switch a tab, ... */
  steps?: AuditStep[];
  /** Measurement root. Default: topmost open dialog or menu, else the page. */
  scope?: string;
  /** Element whose vertical gaps count as dead space. Default: the scope. */
  densityScope?: string;
  /** Skip waiting for spinners to disappear (loading states). */
  settle?: boolean;
  settleMs?: number;
  /** 'tab' (default for overlays), 'arrows' (menus) or false. */
  focusWalk?: 'tab' | 'arrows' | false;
  /** Press Escape at the end and record whether the scope closed. */
  escape?: boolean;
  /** Restrict to these viewport names. */
  viewports?: string[];
  /** Mobile only: shrink the viewport and report where `probe` selectors sit. */
  keyboardOpen?: {
    height?: number;
    focus?: string;
    probe?: Record<string, string>;
  };
}

export const DEFAULT_VIEWPORTS = ['1440x900', '1366x768', '390x844'];

export function parseViewports(spec: string): AuditViewport[] {
  return spec.split(',').map((raw) => {
    const m = /^(\d+)x(\d+)$/.exec(raw.trim());
    if (!m) throw new Error(`Invalid viewport "${raw}", expected WIDTHxHEIGHT`);
    const w = Number(m[1]);
    const h = Number(m[2]);
    return { name: `${w}x${h}`, w, h, mobile: w < 600 };
  });
}

interface Args {
  views: string;
  label: string;
  out: string;
  viewports: string;
  only: string[] | null;
  shots: boolean;
  session: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    views: '',
    label: 'audit',
    out: path.resolve('.playwright-cli/ui-audit'),
    viewports: DEFAULT_VIEWPORTS.join(','),
    only: null,
    shots: false,
    session: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--views') args.views = next();
    else if (a === '--label') args.label = next();
    else if (a === '--out') args.out = path.resolve(next());
    else if (a === '--viewports') args.viewports = next();
    else if (a === '--only') args.only = next().split(',');
    else if (a === '--shots') args.shots = true;
    else if (a === '--session') args.session = next();
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!args.views) throw new Error('--views <file.json> is required');
  if (!/^[\w.-]+$/.test(args.label))
    throw new Error('--label must be [\\w.-]+');
  return args;
}

function extractResult(raw: string): unknown {
  if (raw.includes('### Error')) {
    throw new Error(`playwright-cli reported an error:\n${raw.slice(0, 3000)}`);
  }
  const m =
    /### Result\n([\s\S]*?)\n### /.exec(raw) ??
    /### Result\n([\s\S]*)$/.exec(raw);
  if (!m)
    throw new Error(
      `No result in playwright-cli output:\n${raw.slice(0, 2000)}`,
    );
  const val = JSON.parse(m[1]);
  return typeof val === 'string' ? JSON.parse(val) : val;
}

async function runViewport(
  args: Args,
  viewport: AuditViewport,
  views: AuditView[],
): Promise<Record<string, unknown>> {
  const page = fs.readFileSync(
    path.join(import.meta.dir, 'ui-audit-page.js'),
    'utf8',
  );
  const cfg = {
    label: args.label,
    outDir: args.out,
    shots: args.shots,
    viewports: [viewport],
    views,
  };
  // run-code evaluates one function expression: drop the `;` the formatter adds.
  const source = page
    .replace('__CFG__', () => JSON.stringify(cfg))
    .replace(/;\s*$/, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-audit-'));
  const file = path.join(dir, 'audit.js');
  fs.writeFileSync(file, source);
  try {
    const cmd = ['playwright-cli'];
    if (args.session) cmd.push(`-s=${args.session}`);
    cmd.push('run-code', '--filename', file);
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return extractResult(stdout + stderr) as Record<string, unknown>;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type Cell = Record<string, any>;

/** One row per view x viewport. Exported for tests and other tools. */
export function summarize(report: {
  label: string;
  viewports: Record<string, { views: Record<string, Cell> }>;
}): string {
  const lines: string[] = [`ui:audit ${report.label}`];
  const head = [
    'view',
    'docX',
    'scopeX',
    'offVp',
    'clip',
    'trunc',
    '<24',
    'prim',
    'prim<44',
    'overlap',
    'txtFail/tested',
    'minR',
    'uiFail',
    'noRing',
    'ring<3',
    'ringOuter<3',
    'leftScope',
    'esc',
    'dead%',
  ];
  for (const [vp, v] of Object.entries(report.viewports)) {
    lines.push('', `### ${vp}`, head.join('\t'));
    for (const [name, c] of Object.entries(v.views)) {
      if (c.error) {
        lines.push(`${name}\tERROR ${c.error}`);
        continue;
      }
      const f = c.focus;
      lines.push(
        [
          name,
          c.overflow.documentX,
          c.overflow.scopeX,
          c.overflow.offViewport.length + c.overflow.clippedHorizontally.length,
          c.overflow.scrollAreasX.filter((a: any) => a.kind === 'clipped')
            .length,
          c.truncation.count,
          c.targets.under24,
          c.targets.primaryCount,
          c.targets.primaryUnder44,
          c.collisions.overlappingText + c.collisions.touchingPills,
          `${c.contrast.textFailures}/${c.contrast.textTested}`,
          c.contrast.minTextRatio,
          c.contrast.uiFailures,
          f ? f.withoutRing : '-',
          f ? f.ringContrastBelow3 : '-',
          f ? f.ringOuterBelow3 : '-',
          f ? f.leftScope : '-',
          c.escapeClosesScope ?? '-',
          c.density
            ? `${Math.round(c.density.deadShare * 100)}+${Math.round(c.density.tailShare * 100)}t`
            : '-',
        ].join('\t'),
      );
      const detail = (label: string, items: unknown[] | undefined) => {
        if (items?.length)
          lines.push(`    ${label}: ${JSON.stringify(items).slice(0, 400)}`);
      };
      detail('truncated', c.truncation.list);
      detail('under24', c.targets.under24List);
      detail('primary<44', c.targets.primaryUnder44List);
      detail('overlaps', c.collisions.overlapList);
      detail('textFailures', c.contrast.failureList);
      detail('uiFailures', c.contrast.uiFailureList);
      detail('offViewport', [
        ...c.overflow.offViewport,
        ...c.overflow.clippedHorizontally,
      ]);
      detail(
        'clipped',
        c.overflow.scrollAreasX.filter((a: any) => a.kind === 'clipped'),
      );
      if (f) {
        detail('withoutRing', f.withoutRingList);
        detail('ring<3', f.ringBelow3List);
        detail('unreached', f.unreached);
      }
      if (c.keyboardOpen)
        lines.push(`    keyboardOpen: ${JSON.stringify(c.keyboardOpen)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const parsed = JSON.parse(fs.readFileSync(args.views, 'utf8')) as {
    views: AuditView[];
  };
  let views = parsed.views;
  if (args.only) views = views.filter((v) => args.only!.includes(v.name));
  if (!views.length) throw new Error('No views selected');
  fs.mkdirSync(args.out, { recursive: true });

  const report: any = { label: args.label, origin: null, viewports: {} };
  for (const viewport of parseViewports(args.viewports)) {
    const part = await runViewport(args, viewport, views);
    report.origin = part.origin;
    Object.assign(report.viewports, part.viewports);
  }
  const json = path.join(args.out, `audit-${args.label}.json`);
  const txt = path.join(args.out, `audit-${args.label}-summary.txt`);
  fs.writeFileSync(json, JSON.stringify(report, null, 1));
  const summary = summarize(report);
  fs.writeFileSync(txt, summary);
  console.log(summary);
  console.log(`wrote ${json}\nwrote ${txt}`);
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
