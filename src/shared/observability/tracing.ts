import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * OpenTelemetry must start before instrumented modules (http, express, pg, tedious) are
 * required, so every entrypoint imports this file first. In AWS the exporter targets the
 * ADOT collector sidecar, which forwards to X-Ray. The W3C traceparent header is propagated
 * by the gateway to both upstreams, so a shadow read shows up as two child spans.
 */
let sdk: NodeSDK | undefined;

export function startTracing(serviceName: string): void {
  if (sdk || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? serviceName,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      }),
    ],
  });
  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown();
}
