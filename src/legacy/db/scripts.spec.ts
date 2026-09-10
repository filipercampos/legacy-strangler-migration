import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_SQL_DIR, listScripts, splitBatches, substitute } from './scripts';

describe('legacy script runner', () => {
  it('splits on GO separators only when GO is alone on its line', () => {
    const batches = splitBatches("SELECT 1\nGO\nSELECT N'GOOD'\n  go  \nSELECT 3");
    expect(batches).toEqual(['SELECT 1', "SELECT N'GOOD'", 'SELECT 3']);
  });

  it('substitutes sqlcmd variables and refuses unknown ones', () => {
    expect(substitute('CREATE DATABASE [$(DB_NAME)]', { DB_NAME: 'Billing' })).toBe(
      'CREATE DATABASE [Billing]',
    );
    expect(() => substitute('$(MISSING)', {})).toThrow(/MISSING/);
  });

  it('ships scripts that only reference known variables', () => {
    for (const file of listScripts()) {
      const script = readFileSync(join(LEGACY_SQL_DIR, file), 'utf8');
      expect(() => substitute(script, { DB_NAME: 'x', SEED_CUSTOMERS: '1' })).not.toThrow();
    }
  });
});
