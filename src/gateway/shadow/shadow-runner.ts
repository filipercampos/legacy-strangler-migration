import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { GatewayEnv } from '../../shared/config/env';
import type { Database } from '../../shared/database/schema';
import { DB, ENV } from '../../shared/nest/tokens';
import { emitMetrics } from '../../shared/observability/metrics';
import type { Target } from '../flags';
import { UpstreamClient, type UpstreamRequest, type UpstreamResponse } from '../upstream';
import { compareResponses } from './compare';

export interface ShadowStats {
  compared: number;
  mismatched: number;
  errors: number;
  mismatchRate: number;
}

export interface ShadowJob {
  routeId: string;
  tenantId: string;
  resourceId: string | undefined;
  request: UpstreamRequest;
  served: Target;
  primary: UpstreamResponse;
}

/**
 * Shadow reads: after the caller has its answer, the same request is sent to the *other*
 * side and both responses are compared in canonical form. Never on the request path, never
 * for writes. Results feed the ShadowMismatch / ShadowCompared metrics (alarm on the rate)
 * and diff samples in `shadow_mismatches`; logs carry only field paths, not values.
 */
@Injectable()
export class ShadowRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(ShadowRunner.name);
  private readonly pending = new Set<Promise<void>>();
  private readonly stats = new Map<
    string,
    { compared: number; mismatched: number; errors: number }
  >();

  constructor(
    private readonly upstream: UpstreamClient,
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(ENV) private readonly env: GatewayEnv,
  ) {}

  schedule(job: ShadowJob): void {
    const task = this.run(job).finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  /** Waits for in-flight comparisons (graceful shutdown and tests). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flush();
  }

  snapshot(): Record<string, ShadowStats> {
    const result: Record<string, ShadowStats> = {};
    for (const [route, stat] of this.stats) {
      result[route] = {
        ...stat,
        mismatchRate: stat.compared === 0 ? 0 : stat.mismatched / stat.compared,
      };
    }
    return result;
  }

  private bump(route: string, field: 'compared' | 'mismatched' | 'errors'): void {
    const stat = this.stats.get(route) ?? { compared: 0, mismatched: 0, errors: 0 };
    stat[field] += 1;
    this.stats.set(route, stat);
  }

  private async run(job: ShadowJob): Promise<void> {
    const other: Target = job.served === 'legacy' ? 'modern' : 'legacy';
    let shadow: UpstreamResponse;
    try {
      shadow = await this.upstream.call(other, job.request, this.env.SHADOW_TIMEOUT_MS);
    } catch (error) {
      this.bump(job.routeId, 'errors');
      emitMetrics({ ShadowError: { value: 1, unit: 'Count' } }, { Route: job.routeId });
      this.logger.warn({ err: error, route: job.routeId, target: other }, 'shadow call failed');
      return;
    }

    const [legacy, modern] =
      job.served === 'legacy' ? [job.primary, shadow] : [shadow, job.primary];
    const diff = compareResponses(job.routeId, legacy, modern);
    this.bump(job.routeId, 'compared');
    if (diff.length > 0) this.bump(job.routeId, 'mismatched');
    emitMetrics(
      {
        ShadowCompared: { value: 1, unit: 'Count' },
        ShadowMismatch: { value: diff.length > 0 ? 1 : 0, unit: 'Count' },
        ShadowLatencyDelta: { value: modern.durationMs - legacy.durationMs, unit: 'Milliseconds' },
      },
      { Route: job.routeId },
    );
    if (diff.length === 0) return;

    this.logger.warn(
      {
        route: job.routeId,
        tenant: job.tenantId,
        requestId: job.request.headers['x-request-id'],
        paths: diff.map((d) => d.path),
      },
      'shadow mismatch',
    );
    try {
      await this.db
        .insertInto('shadow_mismatches')
        .values({
          route_id: job.routeId,
          tenant_id: job.tenantId,
          resource_id: job.resourceId ?? null,
          request_id: job.request.headers['x-request-id'] ?? null,
          served_by: job.served,
          diff: JSON.stringify(diff),
        })
        .execute();
    } catch (error) {
      this.logger.warn({ err: error }, 'could not store shadow mismatch sample');
    }
  }
}
