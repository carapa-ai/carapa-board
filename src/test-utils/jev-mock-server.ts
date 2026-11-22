/**
 * In-process mock of the Jev System-1 service (`POST /v1/systemone` and
 * `POST /v1/systemone/batch`). `src/test-preload.ts` starts one per `bun test`
 * process and points `JEV_URL` at it, so no test can reach an external server.
 *
 * Default answers are deterministic and permissive, derived from each
 * question's `type`. A test that needs another outcome scripts
 * `setJevMockHandler` and calls `resetJevMock` in its teardown.
 */

import { isRecord } from '../lib/type-guards.js';

export interface JevMockRequest {
  path: '/v1/systemone' | '/v1/systemone/batch';
  body: Record<string, unknown>;
}

interface JevMockResponse {
  /** HTTP status; defaults to 200. */
  status?: number;
  /** Delay before responding, in milliseconds. */
  delayMs?: number;
  /** Answers for `/v1/systemone`, or for every state of a batch. */
  answers?: Record<string, unknown>;
  /** Per-state answers for a batch; overrides `answers`. */
  results?: Array<{ answers: Record<string, unknown> }>;
}

/** Return `undefined` to fall through to the default answers. */
export type JevMockHandler = (
  request: JevMockRequest,
) => JevMockResponse | undefined | Promise<JevMockResponse | undefined>;

let server: ReturnType<typeof Bun.serve> | undefined;
let handler: JevMockHandler | undefined;
let requests: JevMockRequest[] = [];

/** Criterion labels in object key order or list order. */
function criterionLabels(criteria: unknown): string[] {
  if (Array.isArray(criteria)) return criteria.map(String);
  if (isRecord(criteria)) return Object.keys(criteria);
  return [];
}

function defaultAnswer(question: unknown): Record<string, unknown> {
  const spec = isRecord(question) ? question : {};
  const labels = criterionLabels(spec.criteria);
  switch (spec.type) {
    case 'choice':
      return {
        type: 'choice',
        choice: labels[0],
        answer_confidence: 1,
      };
    case 'noul':
      return { type: 'noul', noul: 1 };
    case 'score':
      return {
        type: 'score',
        score: labels.length > 1 ? labels.length - 1 : 1,
      };
    default:
      return {};
  }
}

function defaultAnswers(questions: unknown): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  if (isRecord(questions)) {
    for (const [id, question] of Object.entries(questions)) {
      answers[id] = defaultAnswer(question);
    }
  }
  return answers;
}

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (
    request.method !== 'POST' ||
    (pathname !== '/v1/systemone' && pathname !== '/v1/systemone/batch')
  ) {
    return new Response('Not found', { status: 404 });
  }
  const body = (await request.json()) as Record<string, unknown>;
  const recorded: JevMockRequest = { path: pathname, body };
  requests.push(recorded);

  const scripted = await handler?.(recorded);
  if (scripted?.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
  }
  if (scripted?.status && scripted.status !== 200) {
    return new Response('Jev mock error', { status: scripted.status });
  }

  const answersFor = (index: number) =>
    scripted?.results?.[index]?.answers ??
    scripted?.answers ??
    defaultAnswers(body.questions);

  if (pathname === '/v1/systemone') {
    return Response.json({ answers: answersFor(0) });
  }
  const states = Array.isArray(body.states) ? body.states : [];
  return Response.json({
    results: states.map((_, index) => ({ answers: answersFor(index) })),
  });
}

/** Start the mock on a free loopback port and return its base URL. Idempotent. */
export function startJevMock(): string {
  server ??= Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handle });
  return `http://127.0.0.1:${server.port}`;
}

export async function stopJevMock(): Promise<void> {
  const running = server;
  server = undefined;
  resetJevMock();
  await running?.stop(true);
}

/** Script the response to every request until `resetJevMock`. */
export function setJevMockHandler(next: JevMockHandler): void {
  handler = next;
}

/** Drop the scripted handler and the recorded requests. */
export function resetJevMock(): void {
  handler = undefined;
  requests = [];
}

/** Request bodies received since the last reset. */
export function jevMockRequests(): readonly JevMockRequest[] {
  return requests;
}
