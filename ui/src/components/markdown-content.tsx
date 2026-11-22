import {
  isBareFileLineReference,
  projectFileFromHref,
  servedArtifactUrl,
  type MarkdownFileOpenHandler,
} from '@/lib/project-file-links';
import {
  KnowledgeComposerContext,
  parseKnowledgeReference,
  openKnowledgeReference,
} from '@/lib/knowledge-reference';
import {
  appLinkPath,
  isPlainLeftClick,
  navigateToAppPath,
} from '@/lib/app-links';
import { useTheme } from '@/lib/theme';
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useMemo,
  useEffect,
  useLayoutEffect,
} from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type ExtraProps,
  type Options,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  Copy,
  Check,
  Send,
  ChevronDown,
  ChevronUp,
  Play,
  Columns3,
  Loader2,
  TriangleAlert,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { normalizeAskUserQuestions } from '@/lib/ask-user-question';
import { ProposalFence } from '@/components/proposal-card';
import { ImageHoverPreview } from '@/components/image-hover-preview';
import {
  ImageTapViewer,
  isTouchPointerType,
} from '@/components/image-tap-viewer';
import { SecureImage } from '@/components/secure-image';
import { cn } from '@/lib/utils';
import type { ToolCallDisplay } from '@/types';
// Bundles both highlight.js themes scoped under .light/.dark (see lib/hljs-themes).
import '@/lib/hljs-themes';

/** Context to pass a send-message callback into deeply nested markdown renderers */
export interface QuestionSubmission {
  codexRequestId?: string;
  answers?: Record<string, { answers: string[] }>;
}
/** A rejected promise tells the question card the send failed so it can unlock. */
export type QuestionSendHandler = (
  text: string,
  submission?: QuestionSubmission,
) => void | Promise<unknown>;
const MarkdownSendContext = createContext<QuestionSendHandler | null>(null);

/** Context to pass the user's answer text into question cards for highlight restoration */
const MarkdownAnswerContext = createContext<string | null>(null);
const MarkdownPlanContext = createContext<
  ((artifactPath: string) => void) | null
>(null);
export interface PlanKanbanAction {
  artifactPath: string;
  planTitle?: string;
  planText?: string;
}
const MarkdownPlanKanbanContext = createContext<
  ((plan: PlanKanbanAction) => Promise<void>) | null
>(null);
const MarkdownArtifactOpenContext =
  createContext<MarkdownFileOpenHandler | null>(null);

/**
 * Notified when a link to one of the app's own routes is activated.
 *
 * The router cannot act on a link to the route that is already open (the URL
 * does not change), so the provider — for example the objective page — uses
 * this to react to a repeated activation.
 *
 * The handler may return a promise: the navigation waits for it, so the
 * provider can ask the user first. The answer decides what happens:
 * - `true`: the provider handled the activation and already asked the active
 *   preview whether it may be left, so the navigation must not ask again.
 * - `false`: the activation is vetoed; the link does nothing at all, which
 *   lets the provider keep the current state (for example an unsaved editor
 *   draft) untouched.
 * - nothing: the provider did not handle the activation; the navigation runs
 *   as usual.
 */
export const MarkdownAppLinkContext = createContext<
  ((path: string) => void | boolean | Promise<void | boolean>) | null
>(null);

/** True when a provider answered with a promise instead of a decision. */
function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Promise<unknown>).then === 'function'
  );
}

function MarkdownAnchor({
  href = '',
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const openArtifact = useContext(MarkdownArtifactOpenContext);
  const projectFolder = useContext(MarkdownProjectFolderContext);
  const file = projectFileFromHref(href, projectFolder);
  const composer = useContext(KnowledgeComposerContext);
  const knowledge = parseKnowledgeReference(href);
  const onAppLink = useContext(MarkdownAppLinkContext);
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (isPlainLeftClick(event, props.download)) {
      if ((file && openArtifact) || (knowledge && composer)) {
        event.preventDefault();
        if (knowledge && composer)
          openKnowledgeReference(composer.projectId, knowledge);
        else if (file && openArtifact)
          openArtifact(file.path, undefined, file.source);
      } else if (!props.target || props.target === '_self') {
        // Links to the app's own routes are opened with the client-side
        // router so the board keeps its state instead of reloading the app.
        const appPath = appLinkPath(href);
        if (appPath) {
          event.preventDefault();
          // The provider may have to react to the activation itself: a link
          // to the route that is already open changes nothing in the router.
          // It may also need the user's answer first (an unsaved draft must
          // not be discarded silently) and may veto the activation, so the
          // navigation waits for its decision.
          const activation = onAppLink?.(appPath);
          const runNavigation = (handled: boolean | void) => {
            if (handled === false) return;
            void navigateToAppPath(appPath, {
              // A handled activation already asked the active preview
              // whether it may be left, so the router's blocker must not
              // ask a second time.
              ignoreBlocker: handled === true,
            });
          };
          if (isPromiseLike(activation)) {
            void activation.then(runNavigation);
          } else {
            runNavigation(activation);
          }
        }
      }
    }
    props.onClick?.(event);
  };
  return (
    <a {...props} href={href} onClick={handleClick}>
      <MarkdownLinkHrefContext.Provider value={href}>
        {children}
      </MarkdownLinkHrefContext.Provider>
    </a>
  );
}

/** Href of the link around an image, so a thumbnail can preview the original. */
const MarkdownLinkHrefContext = createContext<string | undefined>(undefined);
const IMAGE_HREF_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i;

/**
 * Markdown image whose hover preview shows the linked original, if any. A click
 * opens a project file in the preview pane; other images open a full-screen
 * viewer after a touch tap, since touch has no hover.
 */
function MarkdownImage({
  src,
  alt = '',
  node: _node,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement> & ExtraProps) {
  const linkHref = useContext(MarkdownLinkHrefContext);
  const openArtifact = useContext(MarkdownArtifactOpenContext);
  const projectFolder = useContext(MarkdownProjectFolderContext);
  const touchedRef = useRef(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (typeof src !== 'string' || !src) return <img alt={alt} {...props} />;
  const file = projectFileFromHref(src, projectFolder);
  // Agents sometimes write `/workspace/group/artifacts/...`; load the served URL.
  const imageSrc =
    (file && projectFolder && servedArtifactUrl(file, projectFolder)) || src;
  const previewSrc =
    linkHref && IMAGE_HREF_PATTERN.test(linkHref.split(/[?#]/, 1)[0])
      ? linkHref
      : imageSrc;
  const handleClick = (event: React.MouseEvent<HTMLSpanElement>) => {
    if (
      event.button !== 0 ||
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      // A linked image keeps the link's own behaviour.
      event.currentTarget.closest('a')
    )
      return;
    if (file && openArtifact) {
      event.preventDefault();
      openArtifact(file.path, undefined, file.source);
    } else if (touchedRef.current) {
      setViewerOpen(true);
    }
  };
  return (
    <>
      <ImageHoverPreview src={previewSrc} alt={alt}>
        <span
          className={cn(
            'inline-flex max-w-full',
            file && openArtifact && 'cursor-pointer',
          )}
          onPointerDown={(event) => {
            touchedRef.current = isTouchPointerType(event.pointerType);
          }}
          onClick={handleClick}
        >
          <SecureImage
            src={imageSrc}
            alt={alt}
            {...props}
            onLoad={(event) => {
              setFailed(false);
              props.onLoad?.(event);
            }}
            onError={(event) => {
              setFailed(true);
              props.onError?.(event);
            }}
          />
          {failed && (
            <span className="text-xs text-muted-foreground">
              Image unavailable{alt ? `: ${alt}` : ''}
            </span>
          )}
        </span>
      </ImageHoverPreview>
      {viewerOpen && (
        <ImageTapViewer
          src={previewSrc}
          alt={alt}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}

const MarkdownProjectFolderContext = createContext<string | undefined>(
  undefined,
);
const ToolActivityDisplayContext = createContext<{
  display: ToolCallDisplay;
  running: boolean;
  grouped?: boolean;
  onDisclosureChange?: () => void;
}>({ display: 'expanded', running: false });

function PlanAction({
  artifactPath,
  planTitle,
  planText,
}: {
  artifactPath: string;
  planTitle?: string;
  planText?: string;
}) {
  const implement = useContext(MarkdownPlanContext);
  const sendToKanban = useContext(MarkdownPlanKanbanContext);
  const openArtifact = useContext(MarkdownArtifactOpenContext);
  const [kanbanState, setKanbanState] = useState<'idle' | 'sending' | 'sent'>(
    'idle',
  );
  const handleSendToKanban = async () => {
    if (!sendToKanban || kanbanState !== 'idle') return;
    setKanbanState('sending');
    try {
      await sendToKanban({ artifactPath, planTitle, planText });
      setKanbanState('sent');
    } catch {
      setKanbanState('idle');
    }
  };
  return (
    // Translucent blue fill reads on both themes; only the border tone is theme-swapped.
    <div className="my-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-600/30 bg-blue-500/10 px-3 py-2 dark:border-blue-500/25">
      <button
        type="button"
        data-ui="plan-artifact-open"
        onClick={() => openArtifact?.(artifactPath, planText)}
        disabled={!openArtifact}
        title={openArtifact ? 'Open artifact in the right pane' : undefined}
        className="min-w-0 flex-1 truncate text-left text-xs text-blue-700 enabled:hover:text-blue-700 enabled:hover:underline disabled:cursor-default dark:text-blue-100/70 dark:enabled:hover:text-blue-100"
      >
        <span className="block truncate font-medium text-blue-700 dark:text-blue-100">
          {planTitle || artifactPath.split('/').at(-1)}
        </span>
        <code className="block truncate text-[10px] text-blue-700 dark:text-blue-100/50">
          {artifactPath.split('/').at(-1)}
        </code>
      </button>
      {implement && (
        <button
          type="button"
          data-ui="plan-start-implementing"
          onClick={() => implement(artifactPath)}
          // Translucent blue fill + hover read on both themes; border/text tones are theme-swapped.
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-600/40 bg-blue-500/20 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-500/30 dark:border-blue-400/35 dark:text-blue-100"
        >
          <Play size={12} />
          Start implementing
        </button>
      )}
      {sendToKanban && (
        <button
          type="button"
          data-ui="plan-send-to-kanban"
          onClick={() => void handleSendToKanban()}
          disabled={kanbanState !== 'idle'}
          // Translucent blue fill + hover read on both themes; border/text tones are theme-swapped.
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-600/40 bg-blue-500/20 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-500/30 disabled:cursor-default disabled:opacity-70 dark:border-blue-400/35 dark:text-blue-100"
        >
          {kanbanState === 'sending' ? (
            <Loader2 size={12} className="animate-spin" />
          ) : kanbanState === 'sent' ? (
            <Check size={12} />
          ) : (
            <Columns3 size={12} />
          )}
          {kanbanState === 'sent' ? 'Sent to Kanban' : 'Send to Kanban'}
        </button>
      )}
    </div>
  );
}

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/**
 * Extract a leading YAML / TOML frontmatter block from a markdown string.
 *
 * The fence must be at the very top of the file (after an optional BOM and
 * leading whitespace). `---` opens YAML, `+++` opens TOML. We return the raw
 * frontmatter body, the fence marker used (so callers can pick a parser),
 * and the remaining markdown — by default we render the metadata as a small
 * key/value table above the body, which keeps the data visible without the
 * visual mess of `---`/hr + key/value paragraphs that GFM produces otherwise.
 *
 * If the file has no frontmatter (or the opening fence has no matching close)
 * we return the input untouched and `frontmatter` null, so the caller doesn't
 * need to branch on the presence of metadata.
 */
function extractFrontmatter(input: string): {
  frontmatter: string | null;
  format: 'yaml' | 'toml' | null;
  body: string;
} {
  // Tolerate a UTF-8 BOM so detection is robust against hand-edited files
  // saved by tools that prepend one.
  const text = input.replace(/^﻿/, '');
  // The body group handles the empty-body case (`---\n---\n…`) by allowing
  // either nothing OR a non-newline leading char before the lazy match.
  // `\1` back-references the matched opener so `---` opens YAML and `+++`
  // opens TOML with their own closing fence (no cross-matching).
  const m = text.match(
    /^\s*(---|\+\+\+)[ \t]*\r?\n(?:([^\n][\s\S]*?)?\r?\n|)\1[ \t]*(?:\r?\n|$)/,
  );
  if (!m) return { frontmatter: null, format: null, body: text };
  const format = m[1] === '+++' ? 'toml' : 'yaml';
  const frontmatter = m[2] ?? '';
  // A leading `---` that holds no `key: value` rows is ordinary text (e.g. a
  // message starting with a rule); stripping it would drop that text.
  const rows =
    format === 'toml'
      ? parseTomlFrontmatter(frontmatter)
      : parseYamlFrontmatter(frontmatter);
  if (rows.length === 0) return { frontmatter: null, format: null, body: text };
  return { frontmatter, format, body: text.slice(m[0].length) };
}

/**
 * Minimal YAML frontmatter parser.
 *
 * Returns an array of `{ key, value }` preserving the original order of
 * appearance. Supports the shapes that show up in markdown docs in practice:
 *   - `key: value` (string)
 *   - `key: "quoted"` / `key: 'quoted'` (string with quotes stripped)
 *   - `key:` (null)
 *   - `key: [a, b]` / `key: [a, b,]` (inline flow array → joined string)
 *   - `key:` followed by indented list items → joined string
 *
 * We deliberately do not pull in a YAML library: frontmatter is short,
 * the shape we render is a flat key/value table, and the only "complex"
 * values we encounter are arrays (e.g. tags) that join cleanly into a
 * comma-separated string. Anything we don't understand falls through as
 * the raw value text so the user can still read it.
 */
function parseYamlFrontmatter(raw: string): { key: string; value: string }[] {
  const lines = raw.split(/\r?\n/);
  const out: { key: string; value: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines and comment lines so the table stays uncluttered.
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z_][\w.\-]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const tail = m[2].trim();

    // Inline flow array: `key: [a, b, c]`
    if (tail.startsWith('[') && tail.endsWith(']')) {
      const inner = tail.slice(1, -1).trim();
      const items = inner
        ? inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        : [];
      out.push({ key, value: items.join(', ') });
      i++;
      continue;
    }

    // Empty value → null marker (or a block scalar marker)
    if (tail === '' || tail === '|' || tail === '>') {
      // Folded / literal scalars and nested mappings: collect indented
      // continuation lines into a single value. We stop as soon as the
      // indent drops back to the top-level key column. YAML sequence
      // entries (`  - alice`) keep their dash-stripped value so the
      // user sees a flat comma-free list rather than raw `- alice`.
      const parts: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim()) {
          parts.push('');
          i++;
          continue;
        }
        if (!next.startsWith(' ') && !next.startsWith('\t')) break;
        const stripped = next.trim().replace(/^-\s+/, '');
        parts.push(stripped);
        i++;
      }
      if (parts.length) {
        out.push({ key, value: parts.join('\n') });
      } else {
        out.push({ key, value: '' });
      }
      continue;
    }

    // Quoted scalar
    const qm = tail.match(/^(['"])(.*)\1$/);
    out.push({ key, value: qm ? qm[2] : tail });
    i++;
  }
  return out;
}

/** TOML frontmatter shares the same `key = "value"` shape, parsed the same way. */
function parseTomlFrontmatter(raw: string): { key: string; value: string }[] {
  const lines = raw.split(/\r?\n/);
  const out: { key: string; value: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][\w.\-]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    const tail = m[2];
    // Strip surrounding quotes; arrays render as `["a", "b"]` which we keep
    // raw — the user can still read it, and stripping quotes uniformly is
    // simpler than parsing TOML flow arrays.
    const qm = tail.match(/^(['"])(.*)\1$/);
    out.push({ key, value: qm ? qm[2] : tail });
  }
  return out;
}

// -- QuestionCard types --

interface QuestionOption {
  label?: string;
  description?: string;
  /** Mockup or snippet shown beside the option list. */
  preview?: string;
}

interface Question {
  id?: string;
  question?: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

interface QuestionData {
  questions: Question[];
  codexRequestId?: string;
}

// -- QuestionCard component --

function QuestionCard({ data }: { data: QuestionData }) {
  const sendMessage = useContext(MarkdownSendContext);
  const answerText = useContext(MarkdownAnswerContext);

  // Pre-populate selections from the user's answer when the card is already answered (sendMessage is null)
  const initialSelections = useMemo(() => {
    if (!answerText || sendMessage) return {};
    const sel: Record<number, string> = {};
    // Each answer is one line, so match whole lines: `Yes` must not match `Yes, always`.
    const answerLines = answerText.split('\n').map((l) => l.trimEnd());
    for (let qi = 0; qi < data.questions.length; qi++) {
      const q = data.questions[qi];
      if (!q.options) continue;
      // Multi-select picks are restored separately in initialPicks.
      const headerPrefix = q.header ? `${q.header}: ` : '';
      for (const opt of q.multiSelect ? [] : q.options) {
        if (!opt.label) continue;
        if (
          answerLines.includes(`${headerPrefix}${opt.label}`) ||
          answerText === opt.label
        ) {
          sel[qi] = opt.label;
          break;
        }
      }
      if (sel[qi] === undefined) {
        const escapedHeader = q.header
          ? q.header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          : '';
        const customMatch = q.header
          ? answerText.match(
              new RegExp(`\\[${escapedHeader}\\] \\(custom\\): (.+)`),
            )
          : answerText.match(/\(custom\): (.+)/);
        if (customMatch) {
          sel[qi] = `__custom__:${customMatch[1]}`;
        }
      }
    }
    return sel;
  }, [answerText, sendMessage, data.questions]);

  // Multi-select answers are sent as one "Header: a, b" line.
  const initialPicks = useMemo(() => {
    if (!answerText || sendMessage) return {};
    const picked: Record<number, string[]> = {};
    data.questions.forEach((q, qi) => {
      if (!q.multiSelect || !q.options) return;
      const prefix = q.header ? `${q.header}: ` : '';
      const line = prefix
        ? answerText.split('\n').find((entry) => entry.startsWith(prefix))
        : answerText;
      if (!line) return;
      const listed = `, ${line.slice(prefix.length)}, `;
      const labels = q.options
        .map((opt) => opt.label ?? '')
        .filter((label) => label && listed.includes(`, ${label}, `));
      if (labels.length) picked[qi] = labels;
    });
    return picked;
  }, [answerText, sendMessage, data.questions]);

  const [selections, setSelections] =
    useState<Record<number, string>>(initialSelections);
  const [picks, setPicks] = useState<Record<number, string[]>>(initialPicks);
  const [submitted, setSubmitted] = useState(
    !sendMessage &&
      Object.keys(initialSelections).length + Object.keys(initialPicks).length >
        0,
  );
  const inputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  // Per question, the option whose preview is shown (last hovered or focused).
  const [previewFocus, setPreviewFocus] = useState<Record<number, number>>({});
  const submit = useCallback(
    (
      text: string,
      selected: Record<number, string>,
      picked: Record<number, string[]> = {},
    ) => {
      const answers: Record<string, { answers: string[] }> = {};
      data.questions.forEach((question, index) => {
        const value = selected[index];
        const values = [...(picked[index] ?? [])];
        if (value !== undefined)
          values.push(
            value.startsWith('__custom__:')
              ? value.slice('__custom__:'.length)
              : value,
          );
        if (!question.id || values.length === 0) return;
        answers[question.id] = { answers: values };
      });
      const result = sendMessage?.(
        text,
        data.codexRequestId
          ? { codexRequestId: data.codexRequestId, answers }
          : undefined,
      );
      // Failed send: unlock the card, keeping selections/picks, so the user can resubmit.
      if (result && typeof result.then === 'function') {
        result.then(undefined, () => setSubmitted(false));
      }
    },
    [data.codexRequestId, data.questions, sendMessage],
  );

  // Sync selections when initialSelections changes (e.g. after refetch/remount)
  useEffect(() => {
    if (
      !sendMessage &&
      Object.keys(initialSelections).length + Object.keys(initialPicks).length >
        0
    ) {
      setSelections(initialSelections);
      setPicks(initialPicks);
      setSubmitted(true);
    }
  }, [initialSelections, initialPicks, sendMessage]);

  // A single single-choice question submits on click; anything else needs Submit.
  const isMulti =
    data.questions.length > 1 || data.questions.some((q) => q.multiSelect);

  const handleSelect = useCallback(
    (qIndex: number, label: string, header?: string) => {
      if (submitted) return;
      if (data.questions[qIndex]?.multiSelect) {
        setPicks((prev) => {
          const current = prev[qIndex] ?? [];
          return {
            ...prev,
            [qIndex]: current.includes(label)
              ? current.filter((entry) => entry !== label)
              : [...current, label],
          };
        });
        return;
      }
      if (!isMulti && sendMessage) {
        // Single question: submit immediately (existing behavior)
        setSelections((prev) => ({ ...prev, [qIndex]: label }));
        setSubmitted(true);
        const prefix = header ? `${header}: ` : '';
        submit(`${prefix}${label}`, { ...selections, [qIndex]: label });
        return;
      }
      // Multi-question: just record the selection
      setSelections((prev) => ({ ...prev, [qIndex]: label }));
    },
    [submitted, isMulti, sendMessage, selections, submit, data.questions],
  );

  const handleCustomSelect = useCallback(
    (qIndex: number, header?: string) => {
      if (submitted) return;
      const input = inputRefs.current[qIndex];
      const text = input?.value?.trim();
      if (!text) return;
      const answer = header
        ? `[${header}] (custom): ${text}`
        : `(custom): ${text}`;
      if (!isMulti && sendMessage) {
        setSelections((prev) => ({ ...prev, [qIndex]: `__custom__` }));
        setSubmitted(true);
        submit(answer, { ...selections, [qIndex]: `__custom__:${text}` });
        return;
      }
      setSelections((prev) => ({ ...prev, [qIndex]: `__custom__:${text}` }));
    },
    [submitted, isMulti, sendMessage, selections, submit],
  );

  // Real-time custom-input tracking: when the user types in the free-text
  // answer, immediately mark this question's selection as the custom value so
  // any previously-picked option visually deselects and the input becomes the
  // active selection. Emptying the input clears the selection. This avoids
  // requiring the user to press Enter or the inline send button to record
  // their custom answer in multi-question forms.
  const handleCustomInput = useCallback(
    (qIndex: number, value: string) => {
      if (submitted) return;
      const trimmed = value.trim();
      setSelections((prev) => {
        if (!trimmed) {
          // Drop the selection only if it was the custom one — leaves an
          // explicit option pick (re-clicked after starting to type) intact.
          const existing = prev[qIndex];
          if (existing?.startsWith('__custom__')) {
            const next = { ...prev };
            delete next[qIndex];
            return next;
          }
          return prev;
        }
        return { ...prev, [qIndex]: `__custom__:${trimmed}` };
      });
    },
    [submitted],
  );

  const handleSubmitAll = useCallback(() => {
    if (submitted || !sendMessage) return;
    // Build a single message with all answers
    const parts: string[] = [];
    for (let qi = 0; qi < data.questions.length; qi++) {
      const q = data.questions[qi];
      const sel = selections[qi];
      if (picks[qi]?.length) {
        const prefix = q.header ? `${q.header}: ` : '';
        parts.push(`${prefix}${picks[qi].join(', ')}`);
      }
      if (sel === undefined) continue;
      if (sel.startsWith('__custom__:')) {
        const customText = sel.slice('__custom__:'.length);
        const prefix = q.header ? `[${q.header}] ` : '';
        parts.push(`${prefix}(custom): ${customText}`);
      } else {
        const prefix = q.header ? `${q.header}: ` : '';
        parts.push(`${prefix}${sel}`);
      }
    }
    if (parts.length === 0) return;
    setSubmitted(true);
    submit(parts.join('\n'), selections, picks);
  }, [submitted, sendMessage, selections, picks, data.questions, submit]);

  const answeredCount = data.questions.filter(
    (_q, qi) => selections[qi] !== undefined || (picks[qi]?.length ?? 0) > 0,
  ).length;
  const totalQuestions = data.questions.length;

  return (
    <div
      data-ui="ask-user-question-card"
      data-codex-request-id={data.codexRequestId}
      className="flex flex-col gap-3 my-2"
    >
      {data.questions.map((q, qi) => {
        // Picking one option in a multi-select question leaves the others live.
        const hasSelection = !q.multiSelect && selections[qi] !== undefined;
        const isDisabled = submitted;
        return (
          <div
            key={qi}
            className="rounded-lg border border-black/10 bg-black/[0.03] p-3 dark:border-white/10 dark:bg-white/[0.03]"
          >
            {q.header && (
              <p className="text-[10px] font-semibold text-black/60 uppercase tracking-wider mb-1 dark:text-white/40">
                {q.header}
              </p>
            )}
            {q.question && (
              <p className="text-sm text-black/90 mb-2.5 dark:text-white/90">
                {q.question}
              </p>
            )}
            {q.options &&
              q.options.length > 0 &&
              (() => {
                const options = q.options;
                const hasPreview = options.some((opt) => opt.preview);
                const selectedIndex = options.findIndex(
                  (opt) => opt.label === selections[qi],
                );
                const shownIndex =
                  previewFocus[qi] ??
                  (selectedIndex >= 0
                    ? selectedIndex
                    : Math.max(
                        0,
                        options.findIndex((opt) => opt.preview),
                      ));
                const showPreview = (oi: number) => {
                  if (hasPreview)
                    setPreviewFocus((prev) =>
                      prev[qi] === oi ? prev : { ...prev, [qi]: oi },
                    );
                };
                const list = (
                  <div className="flex flex-col gap-1.5">
                    {options.map((opt, oi) => {
                      const rawSel = selections[qi];
                      const isSelected = q.multiSelect
                        ? (picks[qi] ?? []).includes(opt.label ?? '')
                        : rawSel === opt.label;
                      return (
                        <button
                          key={oi}
                          type="button"
                          onMouseEnter={() => showPreview(oi)}
                          onFocus={() => showPreview(oi)}
                          data-preview-shown={
                            hasPreview && oi === shownIndex ? 'true' : undefined
                          }
                          onClick={() =>
                            handleSelect(qi, opt.label || '', q.header)
                          }
                          aria-pressed={q.multiSelect ? isSelected : undefined}
                          disabled={isDisabled || !sendMessage}
                          className={cn(
                            'text-left px-3 py-2 rounded-md text-sm transition-colors border',
                            isSelected
                              ? 'bg-blue-500/20 border-blue-600/50 text-blue-700 dark:border-blue-500/40 dark:text-blue-200'
                              : isDisabled
                                ? 'bg-black/[0.02] border-transparent text-black/25 cursor-not-allowed dark:bg-white/[0.02] dark:text-white/25'
                                : hasSelection
                                  ? 'bg-black/[0.02] border-transparent text-black/60 dark:bg-white/[0.02] dark:text-white/40'
                                  : 'bg-black/5 border-transparent hover:bg-black/10 hover:border-black/20 text-black/80 dark:bg-white/5 dark:hover:bg-white/10 dark:hover:border-white/20 dark:text-white/80',
                            !sendMessage && !isDisabled && 'cursor-default',
                          )}
                        >
                          <span className="font-medium">
                            {q.multiSelect && (
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'mr-2 inline-flex size-3.5 translate-y-0.5 items-center justify-center rounded-sm border',
                                  isSelected
                                    ? // Translucent blue fill reads on both themes; only the border tone is theme-swapped.
                                      'border-blue-600 bg-blue-500/40 dark:border-blue-400'
                                    : 'border-black/30 dark:border-white/30',
                                )}
                              >
                                {isSelected && <Check size={10} />}
                              </span>
                            )}
                            {opt.label}
                          </span>
                          {opt.description && (
                            <span className="block text-xs text-black/60 mt-0.5 dark:text-white/40">
                              {opt.description}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
                if (!hasPreview) return list;
                return (
                  <div className="@container">
                    <div
                      data-ui="ask-user-question-preview-layout"
                      className="grid gap-2 @lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
                    >
                      {list}
                      {/* Every preview occupies the same cell so the panel keeps
                        the size of the largest one. A resize on hover would
                        shift the chat under the pointer and re-trigger hover. */}
                      <div
                        data-ui="ask-user-question-option-preview"
                        className="grid min-h-16 max-h-96 overflow-auto rounded-md border border-black/10 bg-black/5 p-2.5 dark:border-white/10 dark:bg-black/30"
                      >
                        {options.map((opt, oi) => (
                          <pre
                            key={oi}
                            aria-hidden={oi !== shownIndex}
                            className={cn(
                              'm-0 [grid-area:1/1] font-mono text-xs leading-relaxed whitespace-pre',
                              opt.preview
                                ? 'text-black/80 dark:text-white/80'
                                : 'text-black/30 dark:text-white/30',
                              oi !== shownIndex && 'invisible',
                            )}
                          >
                            {opt.preview || 'No preview for this option.'}
                          </pre>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })()}
            {/* Free-text custom answer */}
            {sendMessage &&
              (() => {
                const customActive =
                  selections[qi]?.startsWith('__custom__') ?? false;
                return (
                  <div
                    className={cn(
                      'flex items-center gap-1.5 mt-2',
                      isDisabled && 'opacity-30 pointer-events-none',
                    )}
                  >
                    <Input
                      compact
                      ref={(el) => {
                        inputRefs.current[qi] = el;
                      }}
                      type="text"
                      placeholder="Type a custom answer…"
                      disabled={isDisabled}
                      onInput={(e) =>
                        handleCustomInput(
                          qi,
                          (e.target as HTMLInputElement).value,
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleCustomSelect(qi, q.header);
                        }
                      }}
                      className={cn(
                        'flex-1',
                        customActive && 'text-blue-700 dark:text-blue-200',
                      )}
                    />
                    {/* Inline send button only in single-question mode — in multi
                      mode, the bottom Submit button handles dispatch. */}
                    {!isMulti && (
                      <button
                        type="button"
                        onClick={() => handleCustomSelect(qi, q.header)}
                        disabled={isDisabled}
                        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-black/5 hover:bg-black/10 text-black/50 hover:text-black/80 transition-colors disabled:cursor-not-allowed dark:bg-white/5 dark:hover:bg-white/10 dark:text-white/50 dark:hover:text-white/80"
                        aria-label="Send custom answer"
                      >
                        <Send size={12} />
                      </button>
                    )}
                  </div>
                );
              })()}
          </div>
        );
      })}
      {/* Submit button for multi-question forms */}
      {isMulti && sendMessage && !submitted && (
        <button
          type="button"
          onClick={handleSubmitAll}
          disabled={answeredCount === 0}
          className={cn(
            'flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
            answeredCount > 0
              ? // Translucent blue fill + hover read on both themes; border/text tones are theme-swapped.
                'bg-blue-500/20 border border-blue-600/50 text-blue-700 hover:bg-blue-500/30 dark:border-blue-500/40 dark:text-blue-200'
              : 'bg-black/5 border border-black/10 text-black/25 cursor-not-allowed dark:bg-white/5 dark:border-white/10 dark:text-white/25',
          )}
        >
          <Send size={14} />
          Submit{' '}
          {answeredCount > 0 && totalQuestions > 1
            ? `(${answeredCount}/${totalQuestions})`
            : ''}
        </button>
      )}
    </div>
  );
}

type ToolActivityMarkerKind = 'request' | 'result' | 'error';
type ToolActivityKind = ToolActivityMarkerKind | 'tool-error';
interface ToolActivityMarker {
  kind: ToolActivityMarkerKind;
  toolId?: string;
}

interface MarkdownAstNode {
  type: string;
  value?: string;
  children?: MarkdownAstNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
}

function markdownAstText(node: MarkdownAstNode | undefined): string {
  if (!node) return '';
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(markdownAstText).join('');
}

function createRemarkToolActivity(groupToolActivity: boolean) {
  return function remarkToolActivity() {
    return (tree: MarkdownAstNode) => {
      let pendingMarker: ToolActivityMarker | undefined;
      let previousAllowsImplicitResult = false;
      const children = (tree.children ?? []).filter((node) => {
        if (node.type === 'html' && typeof node.value === 'string') {
          const marker = node.value
            .trim()
            .match(
              /^<!--\s*carapa-tool:(request|result|error)(?:\s+tool-id="([^"]+)")?\s*-->$/,
            );
          if (marker) {
            pendingMarker = {
              kind: marker[1] as ToolActivityMarkerKind,
              toolId: marker[2],
            };
            previousAllowsImplicitResult = false;
            return false;
          }
        }

        if (node.type !== 'blockquote') {
          pendingMarker = undefined;
          previousAllowsImplicitResult = false;
          return true;
        }

        const paragraph = node.children?.find(
          (child) => child.type === 'paragraph',
        );
        const first = paragraph?.children?.[0];
        const rawLabel =
          first?.type === 'strong' ? markdownAstText(first).trim() : '';
        const label = rawLabel.replace(/:\s*$/, '').trim();
        // Server projections that still emit a request without a marker:
        // raw sandbox `call` events (transcript-store.ts) and an
        // AskUserQuestion without questions (agent-display.ts).
        const legacyRequest =
          !rawLabel.endsWith(':') &&
          /^(Using tool:\s+.+|Question)$/i.test(label);
        const toolFailure =
          /^Bash failed$/i.test(label) ||
          (first?.type === 'text' && first.value?.startsWith('⚠️'));

        const explicitMarker = pendingMarker;
        const explicitKind = explicitMarker?.kind;
        let kind: ToolActivityKind | undefined =
          explicitKind === 'error'
            ? explicitMarker?.toolId || toolFailure
              ? 'tool-error'
              : 'error'
            : explicitKind;
        pendingMarker = undefined;
        if (!kind) {
          if (/^Bash failed$/i.test(label)) kind = 'tool-error';
          else if (/^(Error|Turn failed)$/i.test(label)) kind = 'error';
          else if (/^Tool Result$/i.test(label)) kind = 'result';
          else if (legacyRequest) kind = 'request';
          else if (toolFailure) kind = 'tool-error';
          else if (previousAllowsImplicitResult && first?.type !== 'em')
            kind = 'result';
        }

        if (kind) {
          node.data = {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              'data-tool-activity-kind': kind,
              ...(explicitMarker?.toolId
                ? { 'data-tool-call-id': explicitMarker.toolId }
                : {}),
            },
          };
        }
        // Marker-bearing events have authoritative provenance. In particular,
        // an outputless OMP/Codex command may be followed immediately by a
        // reasoning blockquote; treating that quote as an implicit result
        // presents the model's thinking as command output. Keep positional
        // result inference only for the unmarked request shapes the server
        // still emits (`Using tool:` and `Question`).
        previousAllowsImplicitResult =
          kind === 'request' && explicitKind === undefined && legacyRequest;
        return true;
      });

      const resultsByToolId = new Map<
        string,
        { node: MarkdownAstNode; index: number }
      >();
      for (const [index, node] of children.entries()) {
        const kind = node.data?.hProperties?.['data-tool-activity-kind'];
        const toolId = node.data?.hProperties?.['data-tool-call-id'];
        if (
          toolId &&
          (kind === 'result' || kind === 'tool-error') &&
          !resultsByToolId.has(toolId)
        ) {
          resultsByToolId.set(toolId, { node, index });
        }
      }

      const consumedResults = new Set<MarkdownAstNode>();
      const pairedChildren: MarkdownAstNode[] = [];
      for (let index = 0; index < children.length; index += 1) {
        const request = children[index];
        const requestKind =
          request.data?.hProperties?.['data-tool-activity-kind'];
        const toolId = request.data?.hProperties?.['data-tool-call-id'];
        const identifiedResult = toolId
          ? resultsByToolId.get(toolId)
          : undefined;
        const ownedResult =
          identifiedResult && identifiedResult.index > index
            ? identifiedResult.node
            : undefined;
        const result = toolId ? ownedResult : children[index + 1];
        const resultKind =
          result?.data?.hProperties?.['data-tool-activity-kind'];
        if (
          requestKind === 'request' &&
          result &&
          (resultKind === 'result' || resultKind === 'tool-error')
        ) {
          pairedChildren.push({
            type: 'toolCall',
            children: [request, result],
            data: {
              hName: 'tool-call',
              hProperties: {
                'data-tool-call-failed': String(resultKind === 'tool-error'),
                ...(toolId ? { 'data-tool-call-id': toolId } : {}),
              },
            },
          });
          if (ownedResult) consumedResults.add(ownedResult);
          else index += 1;
          continue;
        }
        if (consumedResults.has(request)) continue;
        pairedChildren.push(request);
      }

      if (!groupToolActivity) {
        tree.children = pairedChildren;
        return;
      }

      const isGroupedActivity = (node: MarkdownAstNode) => {
        if (node.type === 'toolCall') return true;
        const kind = node.data?.hProperties?.['data-tool-activity-kind'];
        return kind === 'request' || kind === 'result' || kind === 'tool-error';
      };
      const toolNameOf = (node: MarkdownAstNode): string => {
        const request = node.type === 'toolCall' ? node.children?.[0] : node;
        const paragraph = request?.children?.find(
          (child) => child.type === 'paragraph',
        );
        const first = paragraph?.children?.[0];
        return first?.type === 'strong'
          ? markdownAstText(first).replace(/:\s*$/, '').trim()
          : '';
      };
      const grouped: MarkdownAstNode[] = [];
      let activityRun: MarkdownAstNode[] = [];
      const flushActivityRun = () => {
        if (activityRun.length === 0) return;
        const callCount = activityRun.filter(
          (node) =>
            node.type === 'toolCall' ||
            node.data?.hProperties?.['data-tool-activity-kind'] === 'request',
        ).length;
        const hasToolError = activityRun.some(
          (node) =>
            node.data?.hProperties?.['data-tool-activity-kind'] ===
            'tool-error',
        );
        if (callCount === 0 && !hasToolError) {
          grouped.push(...activityRun);
          activityRun = [];
          return;
        }
        const failedCount = activityRun.filter(
          (node) =>
            node.data?.hProperties?.['data-tool-call-failed'] === 'true' ||
            node.data?.hProperties?.['data-tool-activity-kind'] ===
              'tool-error',
        ).length;
        grouped.push({
          type: 'toolActivityGroup',
          children: activityRun,
          data: {
            hName: 'tool-activity-group',
            hProperties: {
              // A steering split can leave a failed result without its
              // request in this Markdown segment. Keep that orphaned result
              // inside a failed one-call accordion instead of leaking it as
              // a standalone red disclosure.
              'data-tool-call-count': String(
                Math.max(callCount, hasToolError ? 1 : 0),
              ),
              'data-failed-tool-call-count': String(failedCount),
              // One-line summary for the collapsed header: "Read, Bash ×3".
              'data-tool-names': activityRun
                .filter(
                  (node) =>
                    node.type === 'toolCall' ||
                    node.data?.hProperties?.['data-tool-activity-kind'] ===
                      'request',
                )
                .map(toolNameOf)
                .filter(Boolean)
                .join('|'),
            },
          },
        });
        activityRun = [];
      };

      for (const node of pairedChildren) {
        if (isGroupedActivity(node)) {
          activityRun.push(node);
          continue;
        }
        flushActivityRun();
        grouped.push(node);
      }
      flushActivityRun();
      tree.children = grouped;
    };
  };
}

interface StyledBlockquoteProps extends React.HTMLAttributes<HTMLQuoteElement> {
  'data-tool-activity-kind'?: ToolActivityKind;
}

interface ToolActivityGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  'data-tool-call-count'?: string;
  'data-failed-tool-call-count'?: string;
  'data-tool-names'?: string;
}

/** "Read|Bash|Bash" -> "Read, Bash ×2" (first-seen order). */
function summarizeToolNames(names: string | undefined): string {
  if (!names) return '';
  const counts = new Map<string, number>();
  for (const name of names.split('|')) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(', ');
}

interface ToolCallProps extends React.HTMLAttributes<HTMLDivElement> {
  'data-tool-call-failed'?: string;
  'data-tool-call-id'?: string;
}

function ToolCall({ children, ...props }: ToolCallProps) {
  const toolActivity = useContext(ToolActivityDisplayContext);
  const [expanded, setExpanded] = useState(false);
  const childArray = React.Children.toArray(children);
  const request = childArray[0];
  const result = childArray.slice(1);

  // Long output previews at a fixed height; offer a taller view only when it
  // actually overflows (measured while the call is expanded and visible).
  const resultRef = useRef<HTMLDivElement>(null);
  const [outputOverflows, setOutputOverflows] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  useLayoutEffect(() => {
    if (!expanded) return;
    const quote = resultRef.current?.querySelector('blockquote');
    if (!quote) return;
    setOutputOverflows(
      outputExpanded || quote.scrollHeight - quote.clientHeight > 1,
    );
  }, [expanded, outputExpanded, result]);

  const disclosureMountedRef = useRef(false);
  useLayoutEffect(() => {
    if (!disclosureMountedRef.current) {
      disclosureMountedRef.current = true;
      return;
    }
    toolActivity.onDisclosureChange?.();
  }, [expanded, outputExpanded, toolActivity.onDisclosureChange]);

  const toggle = () => setExpanded((value) => !value);
  const failed = props['data-tool-call-failed'] === 'true';
  return (
    <div
      {...props}
      className={cn('relative min-w-0', props.className)}
      data-ui="tool-call"
      data-tool-call-failed={props['data-tool-call-failed']}
      data-tool-call-id={props['data-tool-call-id']}
    >
      <div
        role="button"
        tabIndex={0}
        className="group/tool-call relative cursor-pointer rounded-md outline-none transition-colors hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${failed ? 'failed ' : ''}tool result`}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          toggle();
        }}
      >
        <ToolActivityDisplayContext.Provider
          value={{ ...toolActivity, grouped: true }}
        >
          {request}
        </ToolActivityDisplayContext.Provider>
        <span
          className="pointer-events-none absolute right-3 top-3 rounded bg-background/70 p-0.5 text-muted-foreground transition-colors group-hover/tool-call:text-foreground"
          aria-hidden="true"
        >
          {expanded ? (
            <ChevronUp className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )}
        </span>
      </div>
      <div
        ref={resultRef}
        hidden={!expanded}
        data-ui="tool-call-result"
        data-output-expanded={outputExpanded}
        className="data-[output-expanded=true]:[&_blockquote]:max-h-[60vh]"
      >
        <ToolActivityDisplayContext.Provider
          value={{ ...toolActivity, grouped: true }}
        >
          {result}
        </ToolActivityDisplayContext.Provider>
        {outputOverflows && (
          <button
            type="button"
            data-ui="tool-call-output-toggle"
            aria-expanded={outputExpanded}
            onClick={() => setOutputExpanded((value) => !value)}
            className="mx-2 mb-1.5 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {outputExpanded ? 'Show less' : 'Show more output'}
          </button>
        )}
      </div>
    </div>
  );
}

function ToolActivityGroup({ children, ...props }: ToolActivityGroupProps) {
  const toolActivity = useContext(ToolActivityDisplayContext);
  const [expanded, setExpanded] = useState(false);
  const callCount = Number(props['data-tool-call-count'] ?? 0);
  const failedCount = Number(props['data-failed-tool-call-count'] ?? 0);

  useLayoutEffect(() => {
    if (toolActivity.display === 'compact') setExpanded(false);
  }, [toolActivity.display]);

  const disclosureMountedRef = useRef(false);
  useLayoutEffect(() => {
    if (!disclosureMountedRef.current) {
      disclosureMountedRef.current = true;
      return;
    }
    toolActivity.onDisclosureChange?.();
  }, [expanded, toolActivity.onDisclosureChange]);

  const callLabel = `${callCount.toLocaleString()} tool ${callCount === 1 ? 'call' : 'calls'}`;
  const failureLabel = `${failedCount.toLocaleString()} failed`;
  const action = expanded ? 'Collapse' : 'Expand';
  const accessibleLabel = `${action} ${callLabel}${failedCount > 0 ? `, ${failureLabel}` : ''}`;

  const namesSummary = summarizeToolNames(props['data-tool-names']);
  return (
    <div
      className="my-1.5 min-w-0 rounded-md border border-border/50 bg-muted/10"
      data-ui="tool-activity-group"
      data-tool-call-count={callCount}
      data-failed-tool-call-count={failedCount}
    >
      <button
        type="button"
        className="flex min-h-9 w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-label={accessibleLabel}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground/85">{callLabel}</span>
          {namesSummary && (
            <span data-ui="tool-activity-group-names">
              {' · '}
              {namesSummary}
            </span>
          )}
        </span>
        {failedCount > 0 && (
          <span
            data-ui="tool-activity-group-failed"
            className="inline-flex shrink-0 items-center gap-1 text-[0.6875rem] font-medium uppercase tracking-wide text-red-600 dark:text-red-400"
          >
            <TriangleAlert className="size-3" aria-hidden="true" />
            {failureLabel}
          </span>
        )}
        {expanded ? (
          <ChevronUp className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        )}
      </button>
      <div hidden={!expanded} data-ui="tool-activity-group-details">
        <ToolActivityDisplayContext.Provider
          value={{
            ...toolActivity,
            display: expanded ? 'expanded' : 'compact',
            grouped: true,
          }}
        >
          {children}
        </ToolActivityDisplayContext.Provider>
      </div>
    </div>
  );
}

// -- Styled blockquote for tool calls, bash output, thinking, errors --

function StyledBlockquote({ children, ...props }: StyledBlockquoteProps) {
  const toolKind = props['data-tool-activity-kind'];
  const childArray = React.Children.toArray(children);
  let variant: 'tool' | 'error' | 'thinking' | 'output' =
    toolKind === 'error' || toolKind === 'tool-error'
      ? 'error'
      : toolKind === 'request' || toolKind === 'result'
        ? 'tool'
        : 'output';
  let sawStrong = false;
  let sawWarning = false;
  let sawEm = false;
  let strongLabel = '';

  // Inspect each paragraph's leading child to determine content type.
  // Generated tool/error blockquotes lead with <strong> or a ⚠️ string;
  // wholly emphasized prose is thinking. Common authored callout labels stay
  // generic output rather than being mistaken for agent tool activity.
  for (const child of childArray) {
    if (!React.isValidElement(child)) continue;
    const grandchildren = React.Children.toArray(
      (child.props as { children?: React.ReactNode }).children,
    );
    if (grandchildren.length === 0) continue;

    const first = grandchildren[0];
    if (React.isValidElement(first)) {
      const elType = (
        first as React.ReactElement<{ children?: React.ReactNode }>
      ).type;
      if (elType === 'strong') {
        sawStrong = true;
        strongLabel = extractText(first).replace(/:\s*$/, '').trim();
        break;
      }
      if (elType === 'em') sawEm = true;
    }
    if (typeof first === 'string' && first.startsWith('⚠️')) {
      sawWarning = true;
      variant = 'error';
      break;
    }
  }
  if (variant === 'output' && sawEm && !sawStrong && !sawWarning) {
    variant = 'thinking';
  }

  const toolActivity = useContext(ToolActivityDisplayContext);
  const [expanded, setExpanded] = useState(
    (variant === 'tool' || variant === 'error') &&
      toolActivity.display === 'expanded',
  );
  useLayoutEffect(() => {
    // Paired calls own their disclosure state. Keeping the standalone block-level
    // disclosure in sync as well causes every request/result child to report a
    // second disclosure change during display-mode switches.
    if (!toolActivity.grouped && (variant === 'tool' || variant === 'error')) {
      setExpanded(toolActivity.display === 'expanded');
    }
  }, [toolActivity.display, toolActivity.grouped, variant]);
  const disclosureMountedRef = useRef(false);
  useLayoutEffect(() => {
    if (toolActivity.grouped || (variant !== 'tool' && variant !== 'error'))
      return;
    if (!disclosureMountedRef.current) {
      disclosureMountedRef.current = true;
      return;
    }
    toolActivity.onDisclosureChange?.();
  }, [
    expanded,
    toolActivity.grouped,
    toolActivity.onDisclosureChange,
    variant,
  ]);

  const styles: Record<typeof variant, string> = {
    tool: 'bq-tool',
    error: 'bq-error',
    thinking: 'bq-thinking',
    output: 'bq-output',
  };

  const contentText = extractText(children);

  // Thinking retains its existing independent disclosure behavior.
  const thinkingRef = useRef<HTMLDivElement>(null);
  const [thinkingOverflows, setThinkingOverflows] = useState(false);
  useLayoutEffect(() => {
    if (variant !== 'thinking' || expanded) return;
    const el = thinkingRef.current;
    if (!el) return;
    const measure = () =>
      setThinkingOverflows(el.scrollHeight - el.clientHeight > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [variant, contentText, expanded]);

  if (variant === 'thinking') {
    return (
      <div className="relative my-1.5 group/bq">
        <blockquote
          {...props}
          data-ui="agent-reasoning"
          className={cn(
            'styled-bq transition-colors',
            styles.thinking,
            props.className,
          )}
        >
          <div
            ref={thinkingRef}
            className={cn(
              '[&>p]:my-0!',
              thinkingOverflows && 'pr-6',
              !expanded && 'max-h-[2lh] overflow-hidden',
            )}
          >
            {children}
          </div>
        </blockquote>
        {thinkingOverflows && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="absolute right-1 top-1 z-10 rounded-md border border-border/50 bg-background/50 p-1 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={expanded ? 'Collapse reasoning' : 'Expand reasoning'}
            aria-label={expanded ? 'Collapse reasoning' : 'Expand reasoning'}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        )}
      </div>
    );
  }

  if (variant === 'tool' || variant === 'error') {
    const label =
      strongLabel ||
      (toolKind === 'result'
        ? 'Tool Result'
        : variant === 'error'
          ? 'Error'
          : 'Tool');
    const normalizedLabel = label.toLowerCase();
    const status =
      variant === 'error' || /failed|error/.test(normalizedLabel)
        ? 'Failed'
        : toolKind === 'result' ||
            /result|complete|success|done/.test(normalizedLabel)
          ? 'Completed'
          : toolActivity.running
            ? 'Running'
            : 'Requested';
    const errorSummary = contentText
      .replace(strongLabel, '')
      .replace(/^\s*⚠️?\s*:?\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const action = expanded ? 'Collapse' : 'Expand';

    // During a compact live render, a terminal error can arrive in a later
    // Markdown chunk than the tool activity it belongs to. Do not briefly
    // show that ungrouped red disclosure beneath the failed-call summary;
    // the canonical replay renders the complete, authoritative error.
    if (
      toolActivity.running &&
      toolActivity.display === 'compact' &&
      !toolActivity.grouped &&
      variant === 'error'
    ) {
      return null;
    }

    if (toolActivity.grouped) {
      return (
        <blockquote
          {...props}
          className={cn(
            'styled-bq mx-2 my-1 max-h-[120px] overflow-y-auto transition-colors',
            styles[variant],
            toolKind === 'result' && 'bq-tool-response',
            props.className,
          )}
          data-ui="tool-activity"
          data-tool-variant={variant}
          data-tool-kind={toolKind}
        >
          {children}
        </blockquote>
      );
    }

    // Expanded mode already exposes the original, labelled tool block. An
    // additional disclosure row repeats that label and adds accordion chrome
    // without providing another useful interaction.
    if (toolActivity.display === 'expanded') {
      return (
        <blockquote
          {...props}
          className={cn(
            'styled-bq my-1.5 max-h-[120px] overflow-y-auto transition-colors',
            styles[variant],
            toolKind === 'result' && 'bq-tool-response',
            props.className,
          )}
          data-ui="tool-activity"
          data-tool-variant={variant}
          data-tool-kind={toolKind}
        >
          {children}
        </blockquote>
      );
    }

    return (
      <div
        className="my-1.5 min-w-0 rounded-md border border-border/50 bg-muted/10"
        data-ui="tool-activity"
        data-tool-variant={variant}
        data-tool-kind={toolKind}
      >
        <button
          type="button"
          className="flex min-h-9 w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
          aria-expanded={expanded}
          aria-label={`${action} ${label} tool activity`}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="min-w-0 flex-1 truncate font-medium text-foreground/85">
            {label}
          </span>
          <span
            className="shrink-0 text-muted-foreground/50"
            aria-hidden="true"
          >
            ·
          </span>
          <span className="shrink-0 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground/80">
            {status}
          </span>
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
          )}
        </button>
        {!expanded && variant === 'error' && errorSummary && (
          <p
            className="truncate border-t border-destructive/15 px-2.5 py-1.5 text-xs text-destructive/85"
            title={errorSummary}
          >
            {errorSummary}
          </p>
        )}
        <blockquote
          {...props}
          hidden={!expanded}
          data-ui="tool-activity-details"
          className={cn(
            'styled-bq m-2 mt-0 max-h-[120px] overflow-y-auto transition-colors',
            styles[variant],
            toolKind === 'result' && 'bq-tool-response',
            props.className,
          )}
        >
          {children}
        </blockquote>
      </div>
    );
  }

  const isExpandable = variant === 'output' && contentText.length > 120;
  if (isExpandable) {
    return (
      <div className="relative my-1.5 group/bq">
        <blockquote
          {...props}
          className={cn(
            'styled-bq transition-colors',
            styles.output,
            !expanded && 'max-h-[120px] overflow-hidden mask-fade-bottom',
            expanded && 'max-h-none',
            props.className,
          )}
        >
          {children}
        </blockquote>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="absolute right-1.5 top-1.5 z-10 rounded-md border border-border/50 bg-background/50 p-1 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={expanded ? 'Collapse result' : 'Expand result'}
          aria-label={expanded ? 'Collapse result' : 'Expand result'}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {!expanded && (
          <div
            className="absolute inset-x-0 bottom-0 flex h-8 cursor-pointer items-end justify-center pb-1"
            onClick={() => setExpanded(true)}
          />
        )}
      </div>
    );
  }

  return (
    <blockquote
      {...props}
      className={cn('styled-bq', styles.output, props.className)}
    >
      {children}
    </blockquote>
  );
}

// -- Code block with question detection --

function CopyableCodeBlock({
  children,
  ...props
}: React.HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const projectFolder = useContext(MarkdownProjectFolderContext);

  const handleCopy = useCallback(() => {
    const text = extractText(children as React.ReactNode);
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [children]);

  const plainCodeBlock = (
    <div className="relative group/code">
      <pre
        {...props}
        className={[props.className, 'pr-8 overflow-x-auto max-w-full']
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100 transition-opacity bg-black/10 hover:bg-black/20 text-black/70 hover:text-black dark:bg-white/10 dark:hover:bg-white/20 dark:text-white/70 dark:hover:text-white"
        aria-label="Copy code"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );

  // Check for askuserquestion code blocks (after all hooks to satisfy Rules of Hooks)
  const codeChild = React.Children.toArray(children).find(
    (child) =>
      React.isValidElement(child) &&
      String((child.props as { className?: string }).className || '').includes(
        'language-askuserquestion',
      ),
  );
  if (codeChild && React.isValidElement(codeChild)) {
    const jsonText = extractText(codeChild);
    try {
      const parsed = JSON.parse(jsonText) as {
        questions?: unknown;
        codexRequestId?: string;
      };
      const questions = normalizeAskUserQuestions(parsed.questions);
      if (questions) {
        return (
          <QuestionCard
            data={{ questions, codexRequestId: parsed.codexRequestId }}
          />
        );
      }
    } catch {
      // Fall through to normal code block
    }
  }

  const planChild = React.Children.toArray(children).find(
    (child) =>
      React.isValidElement(child) &&
      String((child.props as { className?: string }).className || '').includes(
        'language-carapaplan',
      ),
  );
  if (planChild && React.isValidElement(planChild)) {
    try {
      const parsed = JSON.parse(extractText(planChild)) as {
        artifactPath?: string;
        planTitle?: string;
        planText?: string;
      };
      if (parsed.artifactPath?.startsWith('artifacts/plans/')) {
        return (
          <PlanAction
            artifactPath={parsed.artifactPath}
            planTitle={parsed.planTitle}
            planText={parsed.planText}
          />
        );
      }
    } catch {
      // Fall through to a normal code block for malformed metadata.
    }
  }

  // A proposal fence names a stored proposal by id only; the card loads the
  // server's record and falls back to this plain block for an unknown id.
  const proposalChild = React.Children.toArray(children).find(
    (child) =>
      React.isValidElement(child) &&
      String((child.props as { className?: string }).className || '').includes(
        'language-carapaproposal',
      ),
  );
  if (proposalChild && React.isValidElement(proposalChild) && projectFolder) {
    try {
      const parsed = JSON.parse(extractText(proposalChild)) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id) {
        return (
          <ProposalFence
            projectId={projectFolder}
            proposalId={parsed.id}
            fallback={plainCodeBlock}
          />
        );
      }
    } catch {
      // Malformed metadata stays a normal code block.
    }
  }

  // Check for fenced ```mermaid blocks. We hand the raw text to MermaidBlock
  // and skip the syntax-highlighted code view — a mermaid diagram rendered
  // as syntax-highlighted plaintext isn't useful, and mermaid will mutate
  // the `<pre class="mermaid">` MermaidBlock passes through.
  const mermaidChild = React.Children.toArray(children).find(
    (child) =>
      React.isValidElement(child) &&
      String((child.props as { className?: string }).className || '').includes(
        'language-mermaid',
      ),
  );
  if (mermaidChild && React.isValidElement(mermaidChild)) {
    const mermaidCode = extractText(mermaidChild);
    // Key by code: mermaid mutates the <pre> in place (data-processed) and
    // the error branch drops it, so a changed diagram needs a fresh instance.
    return <MermaidBlock key={mermaidCode} code={mermaidCode} />;
  }

  return plainCodeBlock;
}

function TableWrapper({
  children,
  ...props
}: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="table-wrapper">
      <table {...props}>{children}</table>
    </div>
  );
}

/** Inner block lets the cell's text be capped at `.table-cell-content`'s max-width. */
function tableCell(Tag: 'th' | 'td') {
  return function TableCell({
    children,
    node: _node,
    ...props
  }: React.HTMLAttributes<HTMLTableCellElement> & { node?: unknown }) {
    return (
      <Tag {...props}>
        <div className="table-cell-content">{children}</div>
      </Tag>
    );
  };
}

const MERMAID_RENDER_DEBOUNCE_MS = 300;

/**
 * Render a fenced ```mermaid block as a live diagram via the mermaid
 * library. The library is dynamically imported on first mermaid block we
 * see so users who never read mermaid-marked files don't pay the ~600KB
 * cost. Mermaid mutates the DOM element in-place after we hand it a
 * `<pre class="mermaid">`, so we just mount that and let the import
 * resolve.
 *
 * Errors fall back to the source text rendered as a plain code block —
 * mermaid's parser is strict and a typo in the diagram shouldn't kill
 * the whole markdown render.
 */
function MermaidBlock({ code }: { code: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const { resolvedTheme } = useTheme();
  const [status, setStatus] = useState<'pending' | 'rendered' | 'error'>(
    'pending',
  );
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    let cancelled = false;
    // Debounce so rapid streaming deltas only render the settled code; the
    // source text stays visible in the <pre> while pending.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const mermaidMod = await import('mermaid');
          if (cancelled) return;
          // mermaid's default export is the API namespace on modern builds.
          const mermaid = (mermaidMod.default ?? mermaidMod) as {
            initialize: (config: Record<string, unknown>) => void;
            run: (opts: { nodes: HTMLElement[] }) => Promise<void>;
            parse: (text: string) => Promise<{ diagramType: string }>;
          };
          // `securityLevel: 'loose'` would allow clickable links inside nodes;
          // for our preview use case (read-only display, no user-supplied
          // links rendered) keep the default 'strict'. The diagram theme
          // follows the resolved app theme, like the hljs code blocks.
          mermaid.initialize({
            startOnLoad: false,
            theme: resolvedTheme === 'dark' ? 'dark' : 'default',
            securityLevel: 'strict',
            fontFamily: 'inherit',
          });
          // Use parse() for syntax validation up front so we can fall back
          // to a code block on a bad diagram instead of letting mermaid
          // throw an uncaught promise rejection.
          await mermaid.parse(code);
          if (cancelled) return;
          // Mermaid writes its SVG into the element we hand it. Using the
          // array form lets us control which element is mutated.
          await mermaid.run({ nodes: [el] });
          if (!cancelled) setStatus('rendered');
        } catch (err) {
          if (cancelled) return;
          setStatus('error');
          setErrorText(err instanceof Error ? err.message : String(err));
        }
      })();
    }, MERMAID_RENDER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, resolvedTheme]);

  if (status === 'error') {
    // Surface the source + error so the user can fix the diagram.
    return (
      // Translucent yellow fill reads on both themes; only the border tone is theme-swapped.
      <div className="rounded-md border border-yellow-600/40 bg-yellow-500/10 p-3 my-2 dark:border-yellow-500/40">
        <div className="text-[11px] uppercase tracking-wide text-yellow-800 mb-1.5 dark:text-yellow-300/80">
          Mermaid diagram failed to render
        </div>
        <pre className="text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words m-0">
          {code}
        </pre>
        {errorText && (
          <div className="mt-2 text-[11px] text-yellow-800 font-mono dark:text-yellow-200/80">
            {errorText}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-2 rounded-md border border-border bg-black/[0.02] dark:bg-white/[0.02] p-3 overflow-auto flex justify-center">
      {/* Mermaid reads the text content of any element with class="mermaid"
        and replaces it with the rendered SVG. We keep the text in the DOM
        until the run() call rewrites it so the user briefly sees the
        source instead of an empty box. The key remounts the element on a
        theme change so mermaid re-renders the diagram instead of reusing
        the already-processed (data-processed) element. */}
      <pre
        key={resolvedTheme}
        ref={preRef}
        className="mermaid m-0"
        data-mermaid-status={status}
      >
        {code}
      </pre>
    </div>
  );
}

/**
 * Renders parsed frontmatter as a compact two-column table. We use the same
 * table class names as the global markdown table styles (`.markdown-output
 * table` / `.prose table`) so the row/column visuals stay consistent with
 * tables that the user writes inside the document body.
 */
function FrontmatterTable({
  raw,
  format,
}: {
  raw: string;
  format: 'yaml' | 'toml';
}) {
  const rows =
    format === 'toml' ? parseTomlFrontmatter(raw) : parseYamlFrontmatter(raw);
  if (rows.length === 0) return null;
  return (
    <div className="table-wrapper frontmatter-table">
      <table>
        <thead>
          <tr>
            <th style={{ width: '30%' }}>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="font-mono text-[12px]">{r.key}</td>
              <td className="font-mono text-[12px] whitespace-pre-wrap break-words">
                {r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
/** react-markdown drops `data:` URLs; allow inline raster images, never links. */
const inlineImageDataUrl =
  /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i;
const markdownUrlTransform: NonNullable<Options['urlTransform']> = (
  url,
  key,
  node,
) =>
  key === 'src' && node.tagName === 'img' && inlineImageDataUrl.test(url)
    ? url
    : // `README.md:10` reads as a URL scheme and would be emptied.
      isBareFileLineReference(url)
      ? url
      : defaultUrlTransform(url);

const markdownComponents = {
  a: MarkdownAnchor,
  img: MarkdownImage,
  pre: CopyableCodeBlock,
  blockquote: StyledBlockquote,
  table: TableWrapper,
  th: tableCell('th'),
  td: tableCell('td'),
  'tool-activity-group': ToolActivityGroup,
  'tool-call': ToolCall,
};

function createLiveRevealPlugin(progress: number, preserveLayout = false) {
  return () => (tree: any) => {
    let totalWords = 0;
    const count = (node: any) => {
      if (node?.type === 'text' && typeof node.value === 'string') {
        totalWords += node.value.match(/\S+/g)?.length ?? 0;
      }
      for (const child of node?.children ?? []) count(child);
    };
    count(tree);
    const visibleWords = Math.floor(
      totalWords * Math.max(0, Math.min(1, progress)),
    );
    let wordIndex = 0;
    const wrap = (node: any) => {
      if (!Array.isArray(node?.children)) return;
      node.children = node.children.flatMap((child: any) => {
        if (child?.type !== 'text' || typeof child.value !== 'string') {
          if (
            child?.type === 'element' &&
            child.tagName === 'br' &&
            wordIndex >= visibleWords
          ) {
            child.properties = {
              ...child.properties,
              ...(preserveLayout
                ? { style: 'visibility: hidden' }
                : { hidden: true }),
            };
          }
          wrap(child);
          return [child];
        }
        return child.value
          .split(/(\s+)/)
          .filter(Boolean)
          .map((part: string) => {
            if (/^\s+$/.test(part)) return { type: 'text', value: part };
            const hidden = wordIndex++ >= visibleWords;
            return {
              type: 'element',
              tagName: 'span',
              properties: {
                dataUi: 'live-voice-reveal-word',
                ...(hidden
                  ? preserveLayout
                    ? { style: 'visibility: hidden' }
                    : { hidden: true }
                  : {}),
              },
              children: [{ type: 'text', value: part }],
            };
          });
      });
    };
    wrap(tree);
  };
}

export function MarkdownContent({
  children,
  onSendMessage,
  onImplementPlan,
  onSendPlanToKanban,
  onOpenArtifact,
  projectFolder,
  questionAnswer,
  liveRevealProgress,
  liveRevealPreserveLayout,
  toolCallDisplay = 'expanded',
  toolActivityRunning = false,
  onToolDisclosureChange,
}: {
  children: string;
  onSendMessage?: QuestionSendHandler;
  onImplementPlan?: (artifactPath: string) => void;
  onSendPlanToKanban?: (plan: PlanKanbanAction) => Promise<void>;
  onOpenArtifact?: MarkdownFileOpenHandler;
  projectFolder?: string;
  questionAnswer?: string;
  liveRevealProgress?: number;
  liveRevealPreserveLayout?: boolean;
  toolCallDisplay?: ToolCallDisplay;
  toolActivityRunning?: boolean;
  onToolDisclosureChange?: () => void;
}) {
  // Use prop if provided, otherwise inherit from outer context
  const outerSend = useContext(MarkdownSendContext);
  const sendFn = onSendMessage ?? outerSend;
  const toolActivityContext = useMemo(
    () => ({
      display: toolCallDisplay,
      running: toolActivityRunning,
      onDisclosureChange: onToolDisclosureChange,
    }),
    [onToolDisclosureChange, toolActivityRunning, toolCallDisplay],
  );
  const toolActivityPlugin = useMemo(
    () => createRemarkToolActivity(toolCallDisplay === 'compact'),
    [toolCallDisplay],
  );

  // Pull any leading frontmatter block out of the source. We render the
  // metadata ourselves (as a small key/value table) so it doesn't get
  // mangled by GFM's `---` rule into a stray `<hr>` + paragraph soup.
  const {
    frontmatter,
    format,
    body: rawBody,
  } = useMemo(
    () =>
      extractFrontmatter(
        // Older stored tool results may contain terminal carriage returns.
        // Keep their continuation lines inside the quoted tool result.
        (children ?? '').replace(/^>[^\n]*$/gm, (line) =>
          line.replace(/\r(?!$)/g, '\n> '),
        ),
      ),
    [children],
  );

  const rehypePlugins = useMemo(
    () =>
      liveRevealProgress == null
        ? [rehypeHighlight]
        : [
            rehypeHighlight,
            createLiveRevealPlugin(
              liveRevealProgress,
              liveRevealPreserveLayout,
            ),
          ],
    [liveRevealPreserveLayout, liveRevealProgress],
  );

  const liveSegments = useMemo(() => {
    const segments: Array<{ kind: 'markdown' | 'live'; value: string }> = [];
    // Marker syntax shown as inline Markdown code is explanatory prose, not a
    // control marker, and must remain intact for ReactMarkdown to render.
    const marker = /\[\[live:\s*([^\]\r\n]+)\]\]/gi;
    let cursor = 0;
    let match: RegExpExecArray | null;
    // Markers inside quoted lines (thinking, tool output) are not narration;
    // splitting there breaks the blockquote, so drop them from the quote.
    const body = rawBody.replace(/^>[^\n]*$/gm, (line) =>
      line.replace(/\[\[live:[^\]\r\n]*\]\]/gi, ' '),
    );
    while ((match = marker.exec(body)) !== null) {
      const codeExample =
        body.slice(0, match.index).trimEnd().endsWith('`') &&
        body
          .slice(match.index + match[0].length)
          .trimStart()
          .startsWith('`');
      if (codeExample) continue;
      if (match.index > cursor)
        segments.push({
          kind: 'markdown',
          value: body.slice(cursor, match.index),
        });
      segments.push({
        kind: 'live',
        value: match[1].replace(/[\t ]+/g, ' ').trim(),
      });
      cursor = match.index + match[0].length;
    }
    if (cursor < body.length || segments.length === 0)
      segments.push({ kind: 'markdown', value: body.slice(cursor) });
    return segments;
  }, [rawBody]);

  const md = (
    <>
      {liveSegments.map((segment, index) =>
        segment.kind === 'live' ? (
          <span
            key={`live-${index}`}
            data-ui="chat-live-status"
            role="status"
            className="not-prose styled-bq bq-thinking block text-[0.8125rem] leading-[1.5]"
          >
            <span className="whitespace-pre-wrap break-words">
              {segment.value}
            </span>
          </span>
        ) : segment.value ? (
          <ReactMarkdown
            key={`markdown-${index}`}
            remarkPlugins={[remarkGfm, toolActivityPlugin]}
            rehypePlugins={rehypePlugins}
            components={markdownComponents}
            urlTransform={markdownUrlTransform}
          >
            {segment.value}
          </ReactMarkdown>
        ) : null,
      )}
    </>
  );

  const withFrontmatter =
    frontmatter && format ? (
      <>
        <FrontmatterTable raw={frontmatter} format={format} />
        {md}
      </>
    ) : (
      md
    );

  // Wrap in send context if we have a send function
  const withSend = sendFn ? (
    <MarkdownSendContext.Provider value={sendFn}>
      {withFrontmatter}
    </MarkdownSendContext.Provider>
  ) : (
    withFrontmatter
  );
  const withPlan = onImplementPlan ? (
    <MarkdownPlanContext.Provider value={onImplementPlan}>
      {withSend}
    </MarkdownPlanContext.Provider>
  ) : (
    withSend
  );
  const withPlanKanban = onSendPlanToKanban ? (
    <MarkdownPlanKanbanContext.Provider value={onSendPlanToKanban}>
      {withPlan}
    </MarkdownPlanKanbanContext.Provider>
  ) : (
    withPlan
  );
  const withArtifactOpen = onOpenArtifact ? (
    <MarkdownArtifactOpenContext.Provider value={onOpenArtifact}>
      {withPlanKanban}
    </MarkdownArtifactOpenContext.Provider>
  ) : (
    withPlanKanban
  );

  const withAnswer =
    questionAnswer != null ? (
      <MarkdownAnswerContext.Provider value={questionAnswer}>
        {withArtifactOpen}
      </MarkdownAnswerContext.Provider>
    ) : (
      withArtifactOpen
    );

  return (
    <ToolActivityDisplayContext.Provider value={toolActivityContext}>
      <MarkdownProjectFolderContext.Provider value={projectFolder}>
        {withAnswer}
      </MarkdownProjectFolderContext.Provider>
    </ToolActivityDisplayContext.Provider>
  );
}
