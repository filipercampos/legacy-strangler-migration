import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../shared/database/schema';

type Executor = Kysely<Database> | Transaction<Database>;

export async function readCheckpoint(db: Executor, stream: string): Promise<bigint | null> {
  const row = await db
    .selectFrom('sync_checkpoints')
    .select('position')
    .where('stream', '=', stream)
    .executeTakeFirst();
  return row?.position ?? null;
}

/** Locks the checkpoint row so two workers can never advance the same stream concurrently. */
export async function lockCheckpoint(
  trx: Transaction<Database>,
  stream: string,
): Promise<bigint | null> {
  const row = await trx
    .selectFrom('sync_checkpoints')
    .select('position')
    .where('stream', '=', stream)
    .forUpdate()
    .executeTakeFirst();
  return row?.position ?? null;
}

export async function writeCheckpoint(
  db: Executor,
  stream: string,
  position: bigint,
): Promise<void> {
  await db
    .insertInto('sync_checkpoints')
    .values({ stream, position })
    .onConflict((oc) => oc.column('stream').doUpdateSet({ position, updated_at: sql<Date>`now()` }))
    .execute();
}
