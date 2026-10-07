import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../shared/nest/tokens';
import type { Target } from './flags';
import type { GatewayEnv } from '../shared/config/env';

export interface UpstreamRequest {
  method: string;
  /** Path + query string, e.g. /api/customers?after=10 */
  url: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
}

export interface UpstreamResponse {
  status: number;
  contentType: string | null;
  body: string;
  durationMs: number;
}

/** Only these headers cross the facade: identity, tracing and content negotiation. */
const FORWARDED = [
  'content-type',
  'accept',
  'x-tenant-id',
  'x-request-id',
  'traceparent',
  'tracestate',
];

@Injectable()
export class UpstreamClient {
  constructor(@Inject(ENV) private readonly env: GatewayEnv) {}

  baseUrl(target: Target): string {
    return target === 'legacy' ? this.env.LEGACY_BASE_URL : this.env.MODERN_BASE_URL;
  }

  async call(
    target: Target,
    request: UpstreamRequest,
    timeoutMs: number,
  ): Promise<UpstreamResponse> {
    const headers: Record<string, string> = {};
    for (const name of FORWARDED) {
      const value = request.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const hasBody = request.body !== undefined && request.method !== 'GET';
    const started = performance.now();
    const response = await fetch(new URL(request.url, this.baseUrl(target)), {
      method: request.method,
      headers,
      body: hasBody ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body,
      durationMs: Math.round(performance.now() - started),
    };
  }
}
