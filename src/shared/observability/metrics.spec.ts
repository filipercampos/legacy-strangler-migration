import { resolveRequestId } from './logging';
import { emitMetrics, METRIC_NAMESPACE } from './metrics';

describe('emitMetrics', () => {
  it('writes one EMF document with dimensions and values', () => {
    const lines: string[] = [];
    emitMetrics(
      { ShadowMismatch: { value: 1, unit: 'Count' } },
      { Route: 'customers.get' },
      (line) => lines.push(line),
    );
    const doc = JSON.parse(lines[0] ?? '{}');
    expect(doc._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: METRIC_NAMESPACE,
      Dimensions: [['Route']],
      Metrics: [{ Name: 'ShadowMismatch', Unit: 'Count' }],
    });
    expect(doc.Route).toBe('customers.get');
    expect(doc.ShadowMismatch).toBe(1);
  });
});

describe('resolveRequestId', () => {
  it('keeps a well-formed caller id and replaces anything else', () => {
    expect(resolveRequestId('abc-123')).toBe('abc-123');
    expect(resolveRequestId('bad id\n')).not.toBe('bad id\n');
    expect(resolveRequestId(['a', 'b'])).toMatch(/^[0-9a-f-]{36}$/);
  });
});
