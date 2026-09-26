import { maxVersion, planBatch } from './batching';

const at = (...versions: number[]) => versions.map((v, i) => ({ version: BigInt(v), id: i }));

describe('planBatch', () => {
  it('keeps a partial batch as is: everything up to the current version was read', () => {
    const items = at(5, 5, 7);
    expect(planBatch(items, 10)).toEqual({ kind: 'complete', items });
  });

  it('gives back the trailing version of a full batch so it is never split', () => {
    const plan = planBatch(at(5, 6, 7, 7), 4);
    expect(plan).toEqual({ kind: 'complete', items: at(5, 6) });
  });

  it('asks for an unbounded read when one version fills the whole batch', () => {
    expect(planBatch(at(9, 9, 9), 3)).toEqual({ kind: 'single-version-overflow', version: 9n });
  });

  it('checkpoints at the highest applied version', () => {
    expect(maxVersion(at(3, 8, 4), 1n)).toBe(8n);
    expect(maxVersion([], 12n)).toBe(12n);
  });
});
