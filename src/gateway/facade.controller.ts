import { All, Controller, Inject, Logger, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { GatewayEnv } from '../shared/config/env';
import { ENV } from '../shared/nest/tokens';
import { emitMetrics } from '../shared/observability/metrics';
import { FlagStore } from './flag-store';
import { decide, type Decision, type Target } from './flags';
import { matchRoute } from './routes';
import { ShadowRunner } from './shadow/shadow-runner';
import { UpstreamClient, type UpstreamRequest, type UpstreamResponse } from './upstream';

/**
 * The strangler facade. Callers keep using the legacy contract (/api/...); each request is
 * routed to legacy or modern by the flag decision, and the served side is echoed in
 * `x-served-by` so callers and dashboards can tell them apart.
 */
@Controller()
export class FacadeController {
  private readonly logger = new Logger(FacadeController.name);

  constructor(
    private readonly flags: FlagStore,
    private readonly upstream: UpstreamClient,
    private readonly shadow: ShadowRunner,
    @Inject(ENV) private readonly env: GatewayEnv,
  ) {}

  @All('api/*path')
  async forward(@Req() req: Request, @Res() res: Response): Promise<void> {
    const tenantId = req.header('x-tenant-id') ?? '';
    const matched = matchRoute(req.method, req.path);
    const routeId = matched?.route.id ?? 'unmatched';
    const upstreamRequest: UpstreamRequest = {
      method: req.method,
      url: req.originalUrl,
      headers: {
        'content-type': req.header('content-type'),
        accept: req.header('accept'),
        'x-tenant-id': req.header('x-tenant-id'),
        'x-request-id': res.getHeader('x-request-id')?.toString() ?? req.header('x-request-id'),
        traceparent: req.header('traceparent'),
        tracestate: req.header('tracestate'),
      },
      body: req.body as unknown,
    };

    const flags = await this.flags.snapshot();
    if (flags.unavailable && matched?.route.kind === 'write') {
      res.status(503).setHeader('retry-after', '5').json({ error: 'SERVICE_UNAVAILABLE' });
      return;
    }

    // Unmatched routes always go to legacy: the facade never breaks an endpoint it does not know.
    const decision: Decision | { target: Target; shadow: false; reason: 'unmatched' } = matched
      ? decide(matched.route, tenantId, matched.resourceId ?? tenantId, flags)
      : { target: 'legacy', shadow: false, reason: 'unmatched' };

    let served: Target = decision.target;
    let response: UpstreamResponse;
    try {
      response = await this.upstream.call(served, upstreamRequest, this.env.UPSTREAM_TIMEOUT_MS);
      if (response.status >= 500 && served === 'modern' && matched?.route.kind === 'read') {
        throw new Error(`modern answered ${response.status}`);
      }
    } catch (error) {
      // Reads served by modern fall back to legacy on errors; writes never retry on the
      // other side (that would be a dual write).
      if (served === 'modern' && matched?.route.kind === 'read') {
        this.logger.warn(
          { err: error, route: routeId },
          'modern read failed, falling back to legacy',
        );
        emitMetrics({ GatewayFallback: { value: 1, unit: 'Count' } }, { Route: routeId });
        served = 'legacy';
        response = await this.upstream.call(served, upstreamRequest, this.env.UPSTREAM_TIMEOUT_MS);
        res.setHeader('x-fallback', 'true');
      } else {
        this.logger.error({ err: error, route: routeId, target: served }, 'upstream failed');
        res.status(502).json({ error: 'BAD_GATEWAY' });
        return;
      }
    }

    emitMetrics(
      {
        GatewayRequests: { value: 1, unit: 'Count' },
        UpstreamLatency: { value: response.durationMs, unit: 'Milliseconds' },
      },
      { Route: routeId, Target: served },
    );
    res.setHeader('x-served-by', served);
    res.setHeader('x-route-reason', decision.reason);
    if (response.contentType) res.setHeader('content-type', response.contentType);
    res.status(response.status).send(response.body);

    // Compare against the other side after the caller has its answer (reads only, by design
    // of decide(); skipped after a fallback because the "other side" just failed).
    if (decision.shadow && matched && res.getHeader('x-fallback') === undefined) {
      this.shadow.schedule({
        routeId,
        tenantId,
        resourceId: matched.resourceId,
        request: upstreamRequest,
        served,
        primary: response,
      });
    }
  }
}
