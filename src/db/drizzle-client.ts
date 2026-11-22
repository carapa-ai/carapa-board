import {
  drizzle as pgDrizzle,
  type NodePgDatabase,
} from 'drizzle-orm/node-postgres';
import {
  drizzle as pgliteDrizzle,
  type PgliteDatabase,
} from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import pkg from 'pg';
const { Pool } = pkg;
import * as schema from './schema.js';
import { logger } from '../logger.js';
import { maxLoopLagSince } from '../lib/event-loop-lag.js';

export type AppDatabase =
  | NodePgDatabase<typeof schema>
  | PgliteDatabase<typeof schema>;

/**
 * Log queries that take longer than this many milliseconds. Set DB_SLOW_MS=0
 * to disable. Designed to surface regressions on hot paths (kanban list,
 * conversation list, chat-message stream) without flooding logs.
 */
const SLOW_QUERY_MS = parseInt(process.env.DB_SLOW_MS ?? '100', 10);

export function summarizeSqlForLog(text: string): {
  operation: string;
  tables: string[];
  sql: string;
} | null {
  const sql = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\$[A-Za-z_0-9]*\$[\s\S]*?\$[A-Za-z_0-9]*\$/g, '?')
    .replace(/'(?:''|[^'])*'/g, '?')
    .replace(/(?<![$\w])\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sql || sql === '<unknown>') return null;

  const operation =
    sql
      .match(
        /\b(select|insert|update|delete|merge|create|alter|drop|vacuum|analyze)\b/i,
      )?.[1]
      ?.toLowerCase() ?? 'other';
  const tables = Array.from(
    sql.matchAll(
      /\b(?:from|join|update|into|table)\s+(?:"([^"]+)"|([A-Za-z_][\w.]*))/gi,
    ),
    (match) => match[1] || match[2],
  )
    .filter((table, index, all) => all.indexOf(table) === index)
    .slice(0, 6);

  return { operation, tables, sql: sql.slice(0, 240) };
}

export function recordTiming(
  startMs: number,
  queryText: string,
  pool?: pkg.Pool,
): void {
  const durationMs = Date.now() - startMs;
  if (SLOW_QUERY_MS > 0 && durationMs >= SLOW_QUERY_MS) {
    const summary = summarizeSqlForLog(queryText);
    if (summary) {
      logger.warn(
        {
          durationMs,
          loopLagMs: maxLoopLagSince(startMs),
          ...summary,
          ...(pool
            ? {
                poolTotal: pool.totalCount,
                poolIdle: pool.idleCount,
                poolWaiting: pool.waitingCount,
              }
            : {}),
        },
        'slow database query',
      );
    }
  }
}

export const drizzleDbRef: { current: AppDatabase } = {
  current: null as unknown as AppDatabase,
};

/** Whether the active Drizzle client supports PostgreSQL-only operations. */
export function isPostgresDatabase(): boolean {
  return typeof (drizzleDbRef.current as any).$client?.connect === 'function';
}

/**
 * Execute a raw SQL statement and return rows in a runtime-agnostic way.
 *
 * PGlite returns `Results<>` where rows are accessible directly as the
 * iterable, while node-pg returns `QueryResult<>` with rows under `.rows`.
 * Normalize at the call boundary.
 */
export async function executeRows<T = any>(query: any): Promise<T[]> {
  const result = await drizzleDbRef.current.execute(query);
  const rows = (result as any).rows ?? result;
  return rows as T[];
}

function instrumentPgPool(pool: pkg.Pool): void {
  pool.on('error', (err) => {
    // pg-pool removes idle clients that emit an error. Log pool pressure here
    // so a recycled broken connection is visible instead of surfacing only as
    // an unrelated MCP timeout.
    logger.error(
      {
        err,
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
      'PostgreSQL pool discarded an unhealthy idle connection',
    );
  });

  if (SLOW_QUERY_MS <= 0) return;
  const original = pool.query.bind(pool);
  (pool as any).query = (...args: unknown[]) => {
    const start = Date.now();
    const text =
      typeof args[0] === 'string'
        ? (args[0] as string)
        : ((args[0] as { text?: string })?.text ?? '<unknown>');
    const result = (original as any)(...args);
    if (result && typeof result.then === 'function') {
      result.then(
        () => recordTiming(start, text, pool),
        () => recordTiming(start, text, pool),
      );
    }
    return result;
  };
}

export function instrumentPglite(client: PGlite): void {
  if (SLOW_QUERY_MS <= 0) return;
  const originalQuery = client.query.bind(client);
  (client as any).query = async (text: string, ...rest: unknown[]) => {
    const start = Date.now();
    try {
      return await (originalQuery as any)(text, ...rest);
    } finally {
      recordTiming(start, text);
    }
  };
  const originalExec = client.exec.bind(client);
  (client as any).exec = async (text: string, ...rest: unknown[]) => {
    const start = Date.now();
    try {
      return await (originalExec as any)(text, ...rest);
    } finally {
      recordTiming(start, text);
    }
  };
}

export function createDrizzleClient(dsnOrPath: string): AppDatabase {
  if (
    dsnOrPath.startsWith('postgres://') ||
    dsnOrPath.startsWith('postgresql://')
  ) {
    const pool = new Pool({
      connectionString: dsnOrPath,
      max: parseInt(process.env.PG_POOL_MAX ?? '20', 10),
      idleTimeoutMillis: parseInt(process.env.PG_POOL_IDLE_MS ?? '30000', 10),
      connectionTimeoutMillis: parseInt(
        process.env.PG_POOL_CONNECT_MS ?? '5000',
        10,
      ),
      // Bound both client-side waits and server-side execution. The latter
      // ensures PostgreSQL cancels work even if the HTTP/MCP caller disappears.
      query_timeout: parseInt(process.env.PG_QUERY_TIMEOUT_MS ?? '30000', 10),
      statement_timeout: parseInt(
        process.env.PG_STATEMENT_TIMEOUT_MS ?? '30000',
        10,
      ),
      // Detect dead Docker-network connections and periodically replace
      // otherwise healthy-looking clients before they can live forever.
      keepAlive: true,
      keepAliveInitialDelayMillis: parseInt(
        process.env.PG_KEEPALIVE_DELAY_MS ?? '10000',
        10,
      ),
      maxLifetimeSeconds: parseInt(
        process.env.PG_POOL_MAX_LIFETIME_SECONDS ?? '300',
        10,
      ),
    });
    instrumentPgPool(pool);
    const client = pgDrizzle(pool, { schema });
    drizzleDbRef.current = client;
    return client;
  } else {
    const path =
      dsnOrPath === ':memory:'
        ? undefined
        : dsnOrPath.endsWith('_pglite')
          ? dsnOrPath
          : dsnOrPath.replace(/\.db$/, '_pglite');
    const client = new PGlite(path);
    instrumentPglite(client);
    const db = pgliteDrizzle(client, { schema });
    drizzleDbRef.current = db;
    return db;
  }
}
