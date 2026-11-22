import path from 'path';
import fs from 'fs';
import { parseMeetingLanguages } from './lib/meeting-languages.js';
import { createSecretReader, parseBooleanEnv } from './lib/env.js';

// ── Docker Compose file-based secrets ──────────────────────────────────
// Capture the secret directory before .env loading to preserve startup precedence.
const readSecret = createSecretReader();
const projectRoot = process.cwd();
// Explicit ENV_FILE always wins. Under `bun test` (NODE_ENV=test) prefer the
// committed .env.test so a developer's local .env can never leak values into
// test environments; without either file no env file is loaded.
let envFile = path.join(projectRoot, process.env.ENV_FILE || '.env');
if (!process.env.ENV_FILE && process.env.NODE_ENV === 'test') {
  envFile = fs.existsSync(path.join(projectRoot, '.env.test'))
    ? path.join(projectRoot, '.env.test')
    : path.join(projectRoot, '.env.test-absent');
}
if (fs.existsSync(envFile)) {
  const envContent = fs.readFileSync(envFile, 'utf-8');
  envContent.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [key, ...values] = trimmed.split('=');
    if (key && values.length > 0) {
      const k = key.trim();
      // Don't overwrite vars already set (e.g. by Docker Compose environment:)
      if (process.env[k] === undefined) {
        process.env[k] = values.join('=').trim();
      }
    }
  });
}

// Inject secrets that are read directly via process.env in other files.
// Map: env var name → secret file name (when they differ).
const SECRET_INJECTIONS: [string, string?][] = [
  ['CARAPA_BOX_API_TOKEN'],
  ['CARAPA_WA_LINK_TOKEN', 'carapa_wa_link_token'],
  ['CARAPA_BOARD_ENCRYPTION_KEY', 'carapa_board_encryption_key'],
];
for (const [key, fileName] of SECRET_INJECTIONS) {
  if (!process.env[key]) {
    const val = readSecret(key, fileName);
    if (val) process.env[key] = val;
  }
}

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Capa';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const STUCK_CONVERSATION_SWEEP_INTERVAL = 60000;
export const ISSUE_IMPORT_POLL_INTERVAL_MS = (() => {
  const value = process.env.ISSUE_IMPORT_POLL_INTERVAL_MS?.trim();
  const parsed = value && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
})();
function parseMaxHandoffLength(value: string | undefined): number {
  const configuredValue = value?.trim();
  const configuredLength =
    configuredValue && /^\d+$/.test(configuredValue)
      ? Number(configuredValue)
      : NaN;
  return Number.isFinite(configuredLength) && configuredLength >= 12_000
    ? configuredLength
    : 32_000;
}
export const MAX_HANDOFF_LENGTH = parseMaxHandoffLength(
  process.env.MAX_HANDOFF_LENGTH,
);
export function parseMaxReviewRejections(value: string | undefined): number {
  const configuredValue = value?.trim();
  const configuredCap =
    configuredValue && /^\d+$/.test(configuredValue)
      ? Number(configuredValue)
      : NaN;
  return Number.isSafeInteger(configuredCap) && configuredCap > 0
    ? configuredCap
    : 8;
}
/** Review rejections (since the last human retry from Question) after which a task is paused. */
export const MAX_REVIEW_REJECTIONS_CAP = parseMaxReviewRejections(
  process.env.MAX_REVIEW_REJECTIONS,
);

// Absolute paths needed for container mounts
export const PROJECT_ROOT = process.cwd();
function readBuildMetadataFile(name: string): string | undefined {
  try {
    return (
      fs.readFileSync(path.join(PROJECT_ROOT, name), 'utf8').trim() || undefined
    );
  } catch {
    return undefined;
  }
}
export const BUILD_VERSION =
  process.env.CARAPA_BUILD_VERSION?.trim() ||
  readBuildMetadataFile('VERSION') ||
  'development';
export const BUILD_TIME = readBuildMetadataFile('BUILD_TIME');
const HOME_DIR = process.env.HOME || '/Users/user';
/** Read-only Codex state used by the explicit deep-link conversation importer. */
export const CODEX_IMPORT_HOME = path.resolve(
  process.env.CODEX_IMPORT_HOME ||
    process.env.CODEX_HOME ||
    path.join(HOME_DIR, '.codex'),
);

// Runtime data directories — can live outside the project via CARAPA_DATA_DIR.
// When set, data/, store/, and groups/ are all under that root.
// When unset, they default to subdirectories of the project root.
const DATA_ROOT = process.env.CARAPA_DATA_DIR || PROJECT_ROOT;
export const DATA_DIR = path.resolve(DATA_ROOT, 'data');
export const STORE_DIR = path.resolve(DATA_ROOT, 'store');
export const GROUPS_DIR = path.resolve(DATA_ROOT, 'groups');
export const KNOWLEDGE_DIR = path.resolve(DATA_ROOT, 'knowledge');
// Host-side groups path for Docker bind mounts (sandbox containers).
// CARAPA_GROUPS_HOST_DIR is set in container mode (docker-compose.yml).
// When not set (host mode), GROUPS_DIR is already a host path.
export const HOST_GROUPS_DIR = process.env.CARAPA_GROUPS_HOST_DIR || GROUPS_DIR;
export const PROMPTS_DIR = path.resolve(PROJECT_ROOT, 'prompts');
export const DEFAULT_SYSTEM_PROMPT_PATH = path.resolve(
  PROJECT_ROOT,
  'prompts',
  'default.md',
);
// File-backed virtual AI user identities managed from the admin UI.
export const AI_USERS_DIR = path.resolve(DATA_DIR, 'ai-users');
// File-backed avatars owned by authenticated human accounts.
export const ACCOUNT_AVATARS_DIR = path.resolve(DATA_DIR, 'account-avatars');

export const RUN_POLL_INTERVAL = 2000; // fallback poll interval for run completion watching

// Anonymous prompting on public conversation shares. These deliberately
// conservative defaults may be tuned by operators without changing the API.
export const PUBLIC_PROMPT_MAX_CHARS = parseInt(
  process.env.PUBLIC_PROMPT_MAX_CHARS || '2000',
  10,
);
export const PUBLIC_PROMPT_VISITOR_WINDOW_MS = parseInt(
  process.env.PUBLIC_PROMPT_VISITOR_WINDOW_MS || '600000',
  10,
);
export const PUBLIC_PROMPT_VISITOR_MAX = parseInt(
  process.env.PUBLIC_PROMPT_VISITOR_MAX || '5',
  10,
);
export const PUBLIC_PROMPT_LINK_HOURLY_MAX = parseInt(
  process.env.PUBLIC_PROMPT_LINK_HOURLY_MAX || '30',
  10,
);
export const PUBLIC_PROMPT_LINK_DAILY_MAX = parseInt(
  process.env.PUBLIC_PROMPT_LINK_DAILY_MAX || '100',
  10,
);
export const PUBLIC_PROMPT_PERSONA_CALL_MAX = parseInt(
  process.env.PUBLIC_PROMPT_PERSONA_CALL_MAX || '4',
  10,
);
export const PUBLIC_PROMPT_TIMEOUT_MS = parseInt(
  process.env.PUBLIC_PROMPT_TIMEOUT_MS || '120000',
  10,
);

// CarapaBox configuration
export const CARAPA_BOX_URL =
  process.env.CARAPA_BOX_URL || 'http://localhost:3100';
export const CARAPA_BOX_API_TOKEN = readSecret('CARAPA_BOX_API_TOKEN');
export const DEFAULT_SANDBOX_STACK =
  process.env.DEFAULT_SANDBOX_STACK || 'carapa-bot';
/**
 * CarapaBox service name used to build and restart CarapaBoard itself. Empty
 * (the default) turns the admin Build app / restart feature off.
 */
export const CARAPA_BOARD_DEPLOY_SERVICE = (
  process.env.CARAPA_BOARD_DEPLOY_SERVICE ?? ''
).trim();
export const BOARD_SELF_DEPLOY_ENABLED = CARAPA_BOARD_DEPLOY_SERVICE !== '';
/**
 * Project folder that receives a fix card when an administrator-requested
 * CarapaBoard build fails. Empty or unset turns the feature off. Read at call
 * time.
 */
export function getBoardBuildFailureProject(): string {
  return (process.env.BOARD_BUILD_FAILURE_PROJECT ?? '').trim();
}
export const DEFAULT_SANDBOX_SERVICE =
  process.env.DEFAULT_SANDBOX_SERVICE || 'agent';
/**
 * Board-visible directories holding the shared template files that generated
 * rule/skill links point at (comma-separated absolute paths). A proposal may
 * read the current content of a linked item only when the link resolves inside
 * the project or one of these roots. Read at call time.
 */
export function getProposalTemplateRoots(): string[] {
  return (process.env.PROPOSAL_TEMPLATE_ROOTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('/'));
}
/**
 * Where approved platform/template proposals are committed. The promotion
 * sandbox project's `/workspace` must hold the carapa-agent-kit checkout (on its
 * branch) and a CarapaBoard checkout that provides `scripts/apply-promotion.ts`.
 * Board runs that fixed script there through CarapaBox and never touches the
 * repositories itself. Read at call time.
 */
export function getPromotionConfig(): {
  sandboxProject: string;
  /** CarapaBoard checkout, used only to locate `scripts/apply-promotion.ts`. */
  boardRepoDir: string;
  kit: { dir: string; branch: string };
} {
  const env = (name: string, fallback: string) =>
    process.env[name]?.trim() || fallback;
  return {
    sandboxProject: env('PROMOTION_SANDBOX_PROJECT', 'carapa'),
    boardRepoDir: env('PROMOTION_BOARD_REPO_DIR', '/workspace/carapa-board'),
    kit: {
      dir: env('PROMOTION_KIT_REPO_DIR', '/workspace/carapa-agent-kit'),
      branch: env('PROMOTION_KIT_BRANCH', 'main'),
    },
  };
}
/** Expire unviewed, inactive shared browsers after 15 minutes; zero disables expiry. */
const browserIdleTimeout = Number(
  process.env.BROWSER_IDLE_TIMEOUT_MS ?? 900_000,
);
export const BROWSER_IDLE_TIMEOUT_MS =
  Number.isFinite(browserIdleTimeout) && browserIdleTimeout >= 0
    ? browserIdleTimeout
    : 900_000;
/** Cut the static tail off Testing-stage recordings; `0` keeps them untouched. */
export const RECORD_TRIM = process.env.CARAPA_RECORD_TRIM !== '0';
export const MCP_AGENT_TIMEOUT = parseInt(
  process.env.MCP_AGENT_TIMEOUT || '600',
  10,
); // seconds (default 10 minutes)
/** Size of one web_view chunk; longer pages are read in chunks via offset. */
const parsedWebViewMaxChars = parseInt(
  process.env.WEB_VIEW_MAX_CHARS || '50000',
  10,
);
export const WEB_VIEW_MAX_CHARS =
  Number.isFinite(parsedWebViewMaxChars) && parsedWebViewMaxChars > 0
    ? parsedWebViewMaxChars
    : 50000;
/** Overall deadline for one delegated browser extraction agent. */
export const WEB_BROWSER_AGENT_TIMEOUT_MS = parseInt(
  process.env.WEB_BROWSER_AGENT_TIMEOUT_MS || '90000',
  10,
);

// Stall detection: idle-based watchdog that complements MCP_AGENT_TIMEOUT.
// Trips when an agent run goes silent (no new output.v1.jsonl or agent-stderr.log
// growth) for longer than STALL_TIMEOUT_MS. If the process PID is still alive,
// the watchdog may grant bounded extensions before the normal STALL_GRACE_MS
// kill grace. STALL_PID_EXTENSION_MS overrides the extension length; when
// unset, each extension uses the run's effective stall timeout.
// Default 600_000ms matches MCP_AGENT_TIMEOUT — per-stage tuning is where the
// win materializes; see settings.stages[].stallTimeoutMs.
export const STALL_TIMEOUT_MS = parseInt(
  process.env.STALL_TIMEOUT_MS || '600000',
  10,
);
export const STALL_GRACE_MS = parseInt(
  process.env.STALL_GRACE_MS || '30000',
  10,
);
export const STALL_WRITE_DEBOUNCE_MS = parseInt(
  process.env.STALL_WRITE_DEBOUNCE_MS || '2000',
  10,
);
export const STALL_PID_EXTENSION_MS = parseInt(
  process.env.STALL_PID_EXTENSION_MS || '0',
  10,
);
export const STALL_PID_MAX_EXTENSIONS = parseInt(
  process.env.STALL_PID_MAX_EXTENSIONS || '2',
  10,
);
// While a run reports running background tasks/subagents (`background_tasks`
// stream event), the stall watchdog is paused for at most this long, so a hung
// subagent still reaches the normal stall countdown. 0 disables the pause.
export const STALL_SUBAGENT_MAX_PAUSE_MS = parseInt(
  process.env.STALL_SUBAGENT_MAX_PAUSE_MS || '3600000',
  10,
);

export const AGENT_CMD = process.env.AGENT_CMD || 'claude';

// Persistent (warm) Claude process per conversation. When enabled, eligible
// chat runs reuse a long-lived `claude` stream-json process inside the sandbox
// instead of spawning an ephemeral `claude -p` per turn. Default OFF — purely
// additive and reversible (run-agent.sh falls back to the ephemeral path when
// off or ineligible). Conversation-owned worktrees are eligible because their
// stable path is part of the warm-session identity; task worktrees remain
// governed by stage-specific eligibility.
export const PERSISTENT_CLAUDE = process.env.CARAPA_PERSISTENT_CLAUDE === '1';
// Enables Codex app-server's native Plan collaboration mode for chat turns
// whose CarapaBoard composer mode is `plan`. Forwarded per run in args.json.env.
export const ENABLE_CODEX_PLAN_MODE = parseBooleanEnv(
  process.env.ENABLE_CODEX_PLAN_MODE,
);

// Transcript archival: compress transcripts older than N days into daily .tar.gz
export const TRANSCRIPT_ARCHIVE_DAYS = parseInt(
  process.env.TRANSCRIPT_ARCHIVE_DAYS || '3',
  10,
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Whether to show exposed container ports in the sidebar as clickable links
export const SHOW_SANDBOX_PORTS = process.env.SHOW_SANDBOX_PORTS === 'true';
// Restart project sandboxes onto rebuilt images when idle, one at a time
export const AUTO_RESTART_OUTDATED_SANDBOXES = parseBooleanEnv(
  process.env.AUTO_RESTART_OUTDATED_SANDBOXES,
);
export const ENABLE_NGINX_PROXY = parseBooleanEnv(
  process.env.ENABLE_NGINX_PROXY,
);
export const BROWSER_LOCAL_HOSTNAMES = (process.env.VITE_LOCAL_HOSTNAMES || '')
  .split(',')
  .map((hostname) => hostname.trim().toLowerCase())
  .filter(Boolean);

function parseCommaListEnv(value: string | undefined, fallback: string) {
  return (value ?? fallback)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// MCP tools the board asks Claude Code to load upfront (`anthropic/alwaysLoad`)
// instead of deferring behind ToolSearch, and the projects (group folders) that
// receive them. An env var set to the empty string turns the feature off.
export const MCP_ALWAYS_LOAD_TOOLS = parseCommaListEnv(
  process.env.MCP_ALWAYS_LOAD_TOOLS,
  'recall,get_task,list_tasks,create_task,memorize,notify_user',
);
export const MCP_ALWAYS_LOAD_PROJECTS = parseCommaListEnv(
  process.env.MCP_ALWAYS_LOAD_PROJECTS,
  'carapa',
);

// carapa-wa-link base URL (derived from MCP_WHATSAPP_URL, stripped of /mcp suffix)
export const MCP_WHATSAPP_BASE_URL = (
  process.env.MCP_WHATSAPP_URL || 'http://localhost:3467/mcp'
).replace(/\/mcp$/, '');

// carapa-wa-link auth token for downloading media attachments
export const CARAPA_WA_LINK_TOKEN = readSecret(
  'CARAPA_WA_LINK_TOKEN',
  'carapa_wa_link_token',
);

// carapa-mail MCP endpoint (direct-LLM connects here with the project's carapaMailToken).
// Container-name convention as with MCP_WHATSAPP_URL; override for any topology.
export const CARAPA_MAIL_MCP_URL =
  process.env.CARAPA_MAIL_MCP_URL || 'http://carapa-mail-carapamail-1:3477/mcp';

// Web Tools configuration
export const SEARXNG_URL = process.env.SEARXNG_URL || 'http://searxng:8080';
// Google-grounded Gemini fallback for web_search (api-relay, no API key).
// Set WEB_SEARCH_GROUNDING_URL to an empty string to disable the fallback.
export const WEB_SEARCH_GROUNDING_URL = (
  process.env.WEB_SEARCH_GROUNDING_URL ?? 'http://api-relay:8080/antigravity'
).trim();
export const WEB_SEARCH_GROUNDING_MODEL =
  process.env.WEB_SEARCH_GROUNDING_MODEL || 'gemini-3-flash';
export const WEB_BROWSER_SIDECAR_URL = (
  process.env.WEB_BROWSER_SIDECAR_URL || 'http://web-browser:3210'
).replace(/\/$/, '');
export const WEB_BROWSER_SIDECAR_TOKEN = readSecret(
  'WEB_BROWSER_SIDECAR_TOKEN',
  'web_browser_sidecar_token',
);
export const WEB_BROWSER_AGENT_GATEWAY_URL = (
  process.env.WEB_BROWSER_AGENT_GATEWAY_URL || 'ws://api-relay:8080/board-api'
).replace(/\/$/, '');
// Hub browser leases for Browser tabs on native runners. The sidecar bounds each
// renewal window (WEB_BROWSER_TAB_LEASE_MS; keep Board and sidecar in agreement)
// and the number of tab sessions (WEB_BROWSER_TAB_MAX_SESSIONS), separately from
// web_view. Board renews until WEB_BROWSER_TAB_MAX_LIFETIME_MS after the start.
export const WEB_BROWSER_TAB_LEASE_MS =
  parseInt(process.env.WEB_BROWSER_TAB_LEASE_MS || '', 10) || 1_200_000;
export const WEB_BROWSER_TAB_MAX_LIFETIME_MS =
  parseInt(process.env.WEB_BROWSER_TAB_MAX_LIFETIME_MS || '', 10) || 14_400_000;

// Image generation. GPT Image over the ChatGPT/Codex OAuth backend is an
// experimental personal-use path and is opt-in; Gemini remains the fallback.
export const ENABLE_GPT_IMAGE_OAUTH = parseBooleanEnv(
  process.env.ENABLE_GPT_IMAGE_OAUTH,
);
export const GPT_IMAGE_MODEL = process.env.GPT_IMAGE_MODEL || 'gpt-image-2';
export const IMAGE_GENERATION_RELAY_URL =
  process.env.IMAGE_GENERATION_RELAY_URL || 'http://api-relay:8080/codex';
export const CLOUD_IMAGE_URL =
  process.env.CLOUD_IMAGE_URL || 'http://api-relay:8080/cloud-image';
export const IMAGE_GENERATION_TIMEOUT_MS = parseInt(
  process.env.IMAGE_GENERATION_TIMEOUT_MS || '600000',
  10,
);
// Avatar generation is an interactive, synchronous admin request and can take
// longer than ordinary image generation when the relay/provider is busy.
export const AVATAR_GENERATION_TIMEOUT_MS = parseInt(
  process.env.AVATAR_GENERATION_TIMEOUT_MS || '900000',
  10,
);

// Service health watcher interval in ms (default 15 seconds). A value below
// the minimum can never take effect: it would hammer the sandbox box with
// overlapping probes. Invalid or non-positive values fall back to the default,
// values in 1..4999 are raised to the minimum.
const SERVICE_WATCHER_DEFAULT_INTERVAL_MS = 15000;
const SERVICE_WATCHER_MIN_INTERVAL_MS = 5000;

function resolveServiceWatcherInterval(raw: string | undefined): {
  /** Env text as configured (undefined when unset), for the startup warning. */
  raw: string | undefined;
  effective: number;
  /** True when the configured value was invalid or below the minimum. */
  adjusted: boolean;
} {
  // Unset means "use the default"; an explicitly empty value is invalid.
  const parsed =
    raw === undefined ? SERVICE_WATCHER_DEFAULT_INTERVAL_MS : parseInt(raw, 10);
  const effective =
    Number.isNaN(parsed) || parsed <= 0
      ? SERVICE_WATCHER_DEFAULT_INTERVAL_MS
      : Math.max(parsed, SERVICE_WATCHER_MIN_INTERVAL_MS);
  return { raw, effective, adjusted: effective !== parsed };
}

const serviceWatcherInterval = resolveServiceWatcherInterval(
  process.env.SERVICE_WATCHER_INTERVAL,
);
export const SERVICE_WATCHER_INTERVAL_RAW = serviceWatcherInterval.raw;
export const SERVICE_WATCHER_INTERVAL_ADJUSTED =
  serviceWatcherInterval.adjusted;
export const SERVICE_WATCHER_INTERVAL = serviceWatcherInterval.effective;

// Consecutive failed health checks required before the watcher restarts a
// service (default 3). Guards against restarting on a single transient probe
// failure (e.g. a 5s timeout during the busy boot window or a brief GC pause).
export const SERVICE_WATCHER_FAILURE_THRESHOLD = parseInt(
  process.env.SERVICE_WATCHER_FAILURE_THRESHOLD || '3',
  10,
);

// CORS allowed origins.
// Unset (default) — same-origin only, plus the Capacitor app origins
// (src/lib/cors.ts). The web UI is served by the Board and needs no CORS.
// Set to a comma-separated list of origins to allow other browser origins,
// e.g. 'https://board.carapa.ai' or 'https://board.carapa.ai,http://localhost:5173'
// '*' allows every origin and logs a warning at startup.
export const CORS_ORIGIN = process.env.CORS_ORIGIN || '';

// Objectives/SMART goals feature flag. Disabled by default; set to "true" or "1" to enable.
export const ENABLE_OBJECTIVES = parseBooleanEnv(process.env.ENABLE_OBJECTIVES);

// WhatsApp messaging via CarapaWaLink. Disabled by default; set to "true" or "1" to enable.
export const ENABLE_WHATSAPP = parseBooleanEnv(process.env.ENABLE_WHATSAPP);

// Automatic transcript memory: the tool reflector runs after chats and tasks
// through defaults.reflector. Also gates DirectLLM's manual /reflect command.
// Disabled by default because it needs a configured model; set to "true" or
// "1" to enable.
export const ENABLE_MEMORY_REFLECTOR = parseBooleanEnv(
  process.env.ENABLE_MEMORY_REFLECTOR,
  false,
);

// Persist each run's exact system prompt as session-transcripts/<runId>.system.txt.
// Disabled by default; set to "true" or "1" to write system-prompt.txt into run dirs.
export const ENABLE_RUN_SYSTEM_PROMPT_TRANSCRIPTS = parseBooleanEnv(
  process.env.ENABLE_RUN_SYSTEM_PROMPT_TRANSCRIPTS,
);

/**
 * LLM call timeout for one automatic transcript-reflector chunk, which may
 * make several tool calls. Preview runs use a fixed 10 minutes.
 */
export const REFLECTOR_CHUNK_TIMEOUT_MS =
  parseInt(process.env.REFLECTOR_CHUNK_TIMEOUT_MS || '', 10) || 300_000;

/** Interval of the pending live reflector row sweep; 0 disables it. */
export const REFLECTOR_PENDING_SWEEP_INTERVAL_MS = (() => {
  const value = process.env.REFLECTOR_PENDING_SWEEP_INTERVAL_MS?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : 120_000;
})();

// Video frame extraction settings
// Enabled by default; set to "false" or "0" to disable.
export const ENABLE_VIDEO = parseBooleanEnv(process.env.ENABLE_VIDEO, true);
export const VIDEO_FPS = parseInt(process.env.VIDEO_FPS || '1', 10);
export const VIDEO_MAX_DURATION = parseInt(
  process.env.VIDEO_MAX_DURATION || '60',
  10,
);

// Path to the GitNexus repository registry (mounted from the gitnexus project)
export const GITNEXUS_REGISTRY_PATH =
  process.env.GITNEXUS_REGISTRY_PATH ||
  path.resolve(DATA_DIR, 'gitnexus', 'registry.json');

// Toolset feature flags (global defaults)
// GitNexus needs a separately deployed hub, so it is opt-in (docker-compose.gitnexus.yml).
export const ENABLE_GITNEXUS = process.env.ENABLE_GITNEXUS === 'true';
export const ENABLE_KANBAN = process.env.ENABLE_KANBAN !== 'false';
export const ENABLE_CHAT = process.env.ENABLE_CHAT !== 'false';
export const ENABLE_MEMORY = process.env.ENABLE_MEMORY !== 'false';

// Memory-capsule selection engine: which filter decides which recalled
// candidates reach the agent.
// "off" (default) applies no engine and keeps every collected candidate
// unfiltered (still token-budget capped). "llm" selects via the LLM
// relevance judge. "shadow" runs the LLM judge and additionally logs Jev
// scores beside its selection without changing what agents receive.
// "jev" selects candidates scoring >= JEV_MIN_SCORE and skips the LLM judge
// (falls back to the judge if Jev fails). "shadow" and "jev" additionally
// require JEV_URL to be set.
export type MemoryCapsuleEngine = 'off' | 'llm' | 'shadow' | 'jev';
export const MEMORY_CAPSULE_ENGINE: MemoryCapsuleEngine =
  process.env.MEMORY_CAPSULE_ENGINE === 'llm' ||
  process.env.MEMORY_CAPSULE_ENGINE === 'shadow' ||
  process.env.MEMORY_CAPSULE_ENGINE === 'jev'
    ? process.env.MEMORY_CAPSULE_ENGINE
    : 'off';
/**
 * Memory-capsule query planning: before recalling, Jev gates whether stored
 * memories could help at all and an LLM proposes short search queries.
 * "off" recalls with the raw prompt only.
 */
export type MemoryCapsuleQueryPlan = 'off' | 'on';
export const MEMORY_CAPSULE_QUERY_PLAN: MemoryCapsuleQueryPlan =
  process.env.MEMORY_CAPSULE_QUERY_PLAN === 'off' ? 'off' : 'on';
/** Minimum expected Jev gate score (0-2) for recall to run; lower skips the capsule. */
export const MEMORY_CAPSULE_GATE_MIN = parseFloat(
  process.env.MEMORY_CAPSULE_GATE_MIN || '0.5',
);
/** Timeout for the LLM call that plans the recall search queries. */
export const MEMORY_CAPSULE_PLAN_TIMEOUT_MS = parseInt(
  process.env.MEMORY_CAPSULE_PLAN_TIMEOUT_MS || '4000',
  10,
);
export const JEV_URL = (process.env.JEV_URL || '').replace(/\/$/, '');
export const JEV_API_KEY = process.env.JEV_API_KEY || '';
export const JEV_TIMEOUT_MS = parseInt(
  process.env.JEV_TIMEOUT_MS || '20000',
  10,
);
/** Minimum Jev relevance score (0-2) for a candidate to be kept in "jev" mode. */
export const JEV_MIN_SCORE = parseFloat(process.env.JEV_MIN_SCORE || '1');
/**
 * Whether the Jev service has `POST /v1/systemone/batch` (self-hosted Laya).
 * Off by default: the hosted API only has `/v1/systemone`, so batches are sent
 * as parallel single calls.
 */
export const JEV_BATCH = /^(1|true|yes|on)$/i.test(process.env.JEV_BATCH || '');
/** Checkpoint sent as `model` when a caller gives none (the hosted API requires one). */
export const JEV_MODEL = process.env.JEV_MODEL || '';
/**
 * Optional hosted Jev used when the primary (`JEV_URL`) is unreachable, e.g.
 * `http://api-relay:8080/jev`. Unset disables failover. The URL must not be in
 * `PRIVACY_LOCAL_ENDPOINT_PREFIXES`: projects in `strict` or `local_memory`
 * privacy mode then never reach it.
 */
export const JEV_FALLBACK_URL = (process.env.JEV_FALLBACK_URL || '').replace(
  /\/$/,
  '',
);
export const JEV_FALLBACK_API_KEY = process.env.JEV_FALLBACK_API_KEY || '';
/** Checkpoint sent to the fallback; defaults to `JEV_MODEL`. */
export const JEV_FALLBACK_MODEL = process.env.JEV_FALLBACK_MODEL || JEV_MODEL;
/** Whether the fallback has `POST /v1/systemone/batch` (the hosted API does not). */
export const JEV_FALLBACK_BATCH = /^(1|true|yes|on)$/i.test(
  process.env.JEV_FALLBACK_BATCH || '',
);
/** Consecutive primary failures after which calls go straight to the fallback. */
export const JEV_BREAKER_FAILURES = parseInt(
  process.env.JEV_BREAKER_FAILURES || '3',
  10,
);
/** How long the fallback is used exclusively before the primary is tried again. */
export const JEV_BREAKER_COOLDOWN_MS = parseInt(
  process.env.JEV_BREAKER_COOLDOWN_MS || '300000',
  10,
);
export const JEV_MAX_CANDIDATES = parseInt(
  process.env.JEV_MAX_CANDIDATES || '32',
  10,
);
/** JSONL sink for shadow scoring results (completed and failed runs). */
/** JSONL sink for shadow scoring results (completed and failed runs). */
export const JEV_SHADOW_LOG_PATH =
  process.env.JEV_SHADOW_LOG_PATH || path.resolve(DATA_DIR, 'jev-shadow.jsonl');
/**
 * Prompt-injection screening of web_view / web_search results through Jev
 * (requires JEV_URL). "warn" (default) adds a warning line to flagged content;
 * "off" only applies the untrusted-content envelope. Content is never blocked
 * or redacted. Anything unrecognized means "warn".
 */
export type WebContentScreening = 'off' | 'warn';
export const WEB_CONTENT_SCREENING: WebContentScreening =
  process.env.WEB_CONTENT_SCREENING === 'off' ? 'off' : 'warn';
/** Jev injection probability (0-1) at or above which web content is flagged. */
const parsedWebInjectionThreshold = parseFloat(
  process.env.WEB_INJECTION_THRESHOLD || '0.8',
);
export const WEB_INJECTION_THRESHOLD = Number.isFinite(
  parsedWebInjectionThreshold,
)
  ? parsedWebInjectionThreshold
  : 0.8;
/**
 * Tool-driven memory reflector gate: "off" (default) does nothing. "shadow"
 * additionally scores each chunk of an automatic live reflector run with Jev
 * and appends the scores beside the chunk's LLM outcome to the shared shadow
 * log; it never skips or alters a chunk. Requires JEV_URL. Anything
 * unrecognized means "off".
 */
export type MemoryReflectorGate = 'off' | 'shadow';
export const MEMORY_REFLECTOR_GATE: MemoryReflectorGate =
  process.env.MEMORY_REFLECTOR_GATE === 'shadow' ? 'shadow' : 'off';
/**
 * Automatic model-tier routing: "off" (default) never routes; "jev" lets
 * `routeText` classify a request's tier through Jev (requires JEV_URL).
 * Anything unrecognized means "off". There is no shadow mode.
 */
export type ModelRoutingEngine = 'off' | 'jev';
export const MODEL_ROUTING_ENGINE: ModelRoutingEngine =
  process.env.MODEL_ROUTING_ENGINE === 'jev' ? 'jev' : 'off';

/**
 * URL prefixes (scheme + host + port + path) of runtimes that keep content on
 * this host. Anything not declared `locality` in board_agents and not matching
 * a prefix is treated as remote.
 */
export const PRIVACY_LOCAL_ENDPOINT_PREFIXES: readonly string[] = (
  process.env.PRIVACY_LOCAL_ENDPOINT_PREFIXES || ''
)
  .split(',')
  .map((prefix) => prefix.trim())
  .filter(Boolean);
/**
 * Engine behind the public-persona safety gate: "llm" (default) asks the
 * `defaults.publicSafetyJudge` runtime; "jev" classifies through Jev (requires
 * JEV_URL) and fails closed when Jev is unavailable, with no LLM fallback.
 * Anything unrecognized means "llm".
 */
export type PublicSafetyJudgeEngine = 'llm' | 'jev';
export const PUBLIC_SAFETY_JUDGE_ENGINE: PublicSafetyJudgeEngine =
  process.env.PUBLIC_SAFETY_JUDGE_ENGINE === 'jev' ? 'jev' : 'llm';
/**
 * Engine behind the knowledge-search chunk verifier: "llm" (default) asks the
 * chat runtime for MATCH/MISMATCH and fails open; "jev" asks Jev for a match
 * probability per chunk (requires JEV_URL), drops a chunk it cannot verify and
 * never falls back to the LLM or to unfiltered candidates. Anything
 * unrecognized means "llm".
 */
export type KnowledgeVerifyEngine = 'llm' | 'jev';
export const KNOWLEDGE_VERIFY_ENGINE: KnowledgeVerifyEngine =
  process.env.KNOWLEDGE_VERIFY_ENGINE === 'jev' ? 'jev' : 'llm';
/**
 * When true, each chat Auto routing decision (including the routed message
 * text) is appended to `<ipc dir>/routing/<conversationId>.jsonl`. Off by
 * default because the file contains user message text.
 */
export const MODEL_ROUTING_LOG = process.env.MODEL_ROUTING_LOG === 'true';
/** Output budget for the memory-capsule relevance judge LLM call. */
export const MEMORY_JUDGE_TIMEOUT_MS = parseInt(
  process.env.MEMORY_JUDGE_TIMEOUT_MS || '20000',
  10,
);
export const ENABLE_FS_TOOLS = process.env.ENABLE_FS_TOOLS !== 'false';

// Bootstrap subsystem flags (global defaults — set to 'false' to disable)
export const ENABLE_SCHEDULER = process.env.ENABLE_SCHEDULER !== 'false';
export const ENABLE_SERVICE_WATCHER =
  process.env.ENABLE_SERVICE_WATCHER !== 'false';
export const AUTO_START_SANDBOXES =
  process.env.AUTO_START_SANDBOXES !== 'false';

// Push notifications (FCM v1). Unset values mean "push disabled" — the MCP
// tool returns a clear error rather than crashing.
export const FCM_PROJECT_ID = process.env.FCM_PROJECT_ID || '';
export const FCM_SERVICE_ACCOUNT_PATH =
  process.env.FCM_SERVICE_ACCOUNT_PATH || '';
export const PUSH_ENABLED = !!(FCM_PROJECT_ID && FCM_SERVICE_ACCOUNT_PATH);

// Meeting recording languages for the Whisper language picker (see meeting-languages.ts).
export const MEETING_LANGUAGES = parseMeetingLanguages(
  process.env.MEETING_LANGUAGES,
);
