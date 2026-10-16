import { checksum } from './parity';

describe('partition checksum', () => {
  it('does not depend on the order rows were read in', () => {
    const a = new Map([
      [2, '{"b":1}'],
      [1, '{"a":1}'],
    ]);
    const b = new Map([
      [1, '{"a":1}'],
      [2, '{"b":1}'],
    ]);
    expect(checksum(a)).toBe(checksum(b));
  });

  it('changes when any row changes', () => {
    const base = new Map([[1, '{"a":1}']]);
    expect(checksum(base)).not.toBe(checksum(new Map([[1, '{"a":2}']])));
    expect(checksum(base)).not.toBe(checksum(new Map([[2, '{"a":1}']])));
  });
});
