/**
 * Minimal CloudWatch Embedded Metric Format writer. Each call prints one JSON line; the
 * awslogs driver / CloudWatch agent turns it into metrics without PutMetricData calls on
 * the hot path. Alarms on replication lag and shadow mismatch rate are defined on these
 * metrics in infra/.
 */
export const METRIC_NAMESPACE = 'StranglerMigration';

export type MetricUnit = 'Count' | 'Seconds' | 'Milliseconds' | 'Percent' | 'None';

export type MetricWriter = (line: string) => void;

const stdoutWriter: MetricWriter = (line) => process.stdout.write(`${line}\n`);

export function emitMetrics(
  metrics: Record<string, { value: number; unit: MetricUnit }>,
  dimensions: Record<string, string> = {},
  write: MetricWriter = stdoutWriter,
): void {
  const values: Record<string, number> = {};
  for (const [name, metric] of Object.entries(metrics)) values[name] = metric.value;

  write(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [Object.keys(dimensions)],
            Metrics: Object.entries(metrics).map(([name, metric]) => ({
              Name: name,
              Unit: metric.unit,
            })),
          },
        ],
      },
      ...dimensions,
      ...values,
    }),
  );
}
