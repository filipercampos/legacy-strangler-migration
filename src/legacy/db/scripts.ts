import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type sql from 'mssql';

export const LEGACY_SQL_DIR = join(__dirname, '..', '..', '..', 'legacy', 'sql');

/** Splits a T-SQL script on `GO` batch separators, like sqlcmd does. */
export function splitBatches(script: string): string[] {
  return script
    .split(/^\s*GO\s*$/im)
    .map((batch) => batch.trim())
    .filter((batch) => batch.length > 0);
}

/** sqlcmd-style `$(NAME)` substitution. Unknown variables are an error, not an empty string. */
export function substitute(script: string, variables: Record<string, string>): string {
  return script.replace(/\$\(([A-Z_]+)\)/g, (_, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new Error(`Missing script variable ${name}`);
    return value;
  });
}

export function listScripts(directory = LEGACY_SQL_DIR): string[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

/**
 * Applies the legacy scripts. `001_database.sql` runs against master (it creates the
 * database); everything else runs inside the target database.
 */
export async function runLegacyScripts(
  master: sql.ConnectionPool,
  target: () => Promise<sql.ConnectionPool>,
  variables: Record<string, string>,
  options: { includeSeed: boolean; directory?: string },
): Promise<void> {
  const directory = options.directory ?? LEGACY_SQL_DIR;
  const files = listScripts(directory).filter(
    (file) => options.includeSeed || !file.includes('seed'),
  );
  let pool: sql.ConnectionPool | undefined;
  try {
    for (const file of files) {
      const script = substitute(readFileSync(join(directory, file), 'utf8'), variables);
      const connection = file.startsWith('001_') ? master : (pool ??= await target());
      for (const batch of splitBatches(script)) {
        await connection.request().batch(batch);
      }
    }
  } finally {
    await pool?.close();
  }
}
