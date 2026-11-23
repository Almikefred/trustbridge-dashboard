/**
 * Soroban outbox worker.
 *
 * Process topology (see docs/DEPLOYMENT.md):
 *   - web (Next.js): enqueues outbox rows, never drains them.
 *   - outbox worker (this module): drains pending rows and pushes Wave sync.
 *   - cron/export scheduler: runs periodic exports; takes an advisory lock.
 *
 * Health probes:
 *   - liveness:  process is running and the poll loop has ticked recently.
 *   - readiness: DB reachable and no stale lock held by a dead worker.
 */

import { getPool } from "./db";

export const OUTBOX_POLL_INTERVAL_MS = Number(
  process.env.OUTBOX_POLL_INTERVAL_MS ?? 5000,
);

export const OUTBOX_BATCH_SIZE = Number(
  process.env.OUTBOX_BATCH_SIZE ?? 50,
);

export const OUTBOX_MAX_ATTEMPTS = Number(
  process.env.OUTBOX_MAX_ATTEMPTS ?? 5,
);

/** A worker that has not ticked within this window is considered unhealthy. */
export const OUTBOX_LIVENESS_STALE_MS = Number(
  process.env.OUTBOX_LIVENESS_STALE_MS ?? 60_000,
);

/** Advisory lock TTL for the cron/export scheduler. */
export const CRON_EXPORT_LOCK_TTL_MS = Number(
  process.env.CRON_EXPORT_LOCK_TTL_MS ?? 300_000,
);

export type OutboxWorkerHealth = {
  live: boolean;
  ready: boolean;
  lastTickAt: number | null;
  pendingCount: number | null;
  reason?: string;
};

let lastTickAt: number | null = null;

export function recordTick(now: number = Date.now()): void {
  lastTickAt = now;
}

export function getLastTickAt(): number | null {
  return lastTickAt;
}

/**
 * Liveness: the poll loop must have ticked within OUTBOX_LIVENESS_STALE_MS.
 * A failing liveness probe means the worker process is hung or not scheduled.
 */
export function checkLiveness(now: number = Date.now()): boolean {
  if (lastTickAt === null) return false;
  return now - lastTickAt <= OUTBOX_LIVENESS_STALE_MS;
}

/**
 * Readiness: DB reachable and outbox backlog is drainable. A failing readiness
 * probe means the worker cannot make progress (DB down, or backlog growing
 * because no worker is consuming rows).
 */
export async function checkReadiness(): Promise<OutboxWorkerHealth> {
  const live = checkLiveness();
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM soroban_outbox WHERE status = 'pending'",
    );
    const pendingCount = Number(rows[0]?.count ?? 0);
    return {
      live,
      ready: live,
      lastTickAt,
      pendingCount,
      reason: live ? undefined : "worker has not ticked recently",
    };
  } catch (err) {
    return {
      live,
      ready: false,
      lastTickAt,
      pendingCount: null,
      reason: err instanceof Error ? err.message : "database unreachable",
    };
  }
}

export type OutboxRow = {
  id: string;
  payload: unknown;
  attempts: number;
};

export type OutboxHandler = (row: OutboxRow) => Promise<void>;

/**
 * Drain one batch of pending outbox rows. Idempotent per row: rows are marked
 * `done` only after the handler resolves; failures increment attempts and are
 * retried until OUTBOX_MAX_ATTEMPTS, then marked `failed` with a reason code.
 */
export async function drainOnce(handler: OutboxHandler): Promise<{
  processed: number;
  failed: number;
}> {
  recordTick();
  const pool = getPool();
  const { rows } = await pool.query<OutboxRow>(
    `SELECT id, payload, attempts
       FROM soroban_outbox
      WHERE status = 'pending' AND attempts < $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [OUTBOX_MAX_ATTEMPTS, OUTBOX_BATCH_SIZE],
  );

  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await handler(row);
      await pool.query(
        "UPDATE soroban_outbox SET status = 'done', updated_at = now() WHERE id = $1",
        [row.id],
      );
      processed += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      const status = attempts >= OUTBOX_MAX_ATTEMPTS ? "failed" : "pending";
      await pool.query(
        `UPDATE soroban_outbox
            SET attempts = $2, status = $3, last_error = $4, updated_at = now()
          WHERE id = $1`,
        [row.id, attempts, status, err instanceof Error ? err.message : String(err)],
      );
      failed += 1;
    }
  }
  return { processed, failed };
}

/**
 * Start the poll loop. Returns a stop function for graceful shutdown.
 * The web process must NOT call this; only the dedicated outbox worker does.
 */
export function startOutboxWorker(handler: OutboxHandler): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await drainOnce(handler);
    } catch {
      // Errors are surfaced via readiness probe and outbox row last_error.
    } finally {
      if (!stopped) timer = setTimeout(tick, OUTBOX_POLL_INTERVAL_MS);
    }
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
