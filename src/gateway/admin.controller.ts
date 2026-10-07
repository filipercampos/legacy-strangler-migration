import {
  BadRequestException,
  Body,
  type CanActivate,
  Controller,
  createParamDecorator,
  type ExecutionContext,
  Get,
  Inject,
  Injectable,
  Post,
  Put,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { GatewayEnv } from '../shared/config/env';
import { ENV } from '../shared/nest/tokens';
import { FlagStore } from './flag-store';
import { ROUTES } from './routes';

/**
 * Admin endpoints are reachable only on the internal ALB listener restricted to the ops VPN
 * (see infra), and additionally require the admin token. The actor header is mandatory and
 * lands in routing_audit.
 */
@Injectable()
class AdminGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: GatewayEnv) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = Buffer.from(request.header('x-admin-token') ?? '');
    const expected = Buffer.from(this.env.ADMIN_TOKEN);
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
      throw new UnauthorizedException();
    }
    if (!/^[\w.@-]{2,64}$/.test(request.header('x-admin-actor') ?? '')) {
      throw new BadRequestException('x-admin-actor header required');
    }
    return true;
  }
}

const ActorHeader = createParamDecorator(
  (_: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<Request>().header('x-admin-actor') ?? 'unknown',
);

const percent = z.number().int().min(0).max(100);
const tenant = z.string().regex(/^([A-Z0-9]{1,10}|\*)$/);

const ruleSchema = z.object({
  routeId: z.enum(ROUTES.map((route) => route.id) as [string, ...string[]]),
  tenantId: tenant,
  modernPercent: percent,
  shadowPercent: percent,
});
const killSwitchSchema = z.object({ on: z.boolean() });
const ownershipSchema = z.object({
  entity: z.enum(['customers', 'invoices']),
  tenantId: z.string().regex(/^[A-Z0-9]{1,10}$/),
  owner: z.enum(['legacy', 'modern']),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.issues);
  return result.data;
}

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly flags: FlagStore) {}

  @Get('flags')
  async current() {
    this.flags.invalidate();
    const snapshot = await this.flags.snapshot();
    return { ...snapshot, owners: Object.fromEntries(snapshot.owners) };
  }

  @Put('rules')
  async rule(@Body() body: unknown, @ActorHeader() actor: string) {
    const rule = parse(ruleSchema, body);
    await this.flags.upsertRule(rule, actor);
    return rule;
  }

  /** Instant rollback: every route to legacy, shadow traffic off. */
  @Post('kill-switch')
  async killSwitch(@Body() body: unknown, @ActorHeader() actor: string) {
    const { on } = parse(killSwitchSchema, body);
    await this.flags.setKillSwitch(on, actor);
    return { killSwitch: on };
  }

  @Put('ownership')
  async ownership(@Body() body: unknown, @ActorHeader() actor: string) {
    const change = parse(ownershipSchema, body);
    await this.flags.setOwner(change.entity, change.tenantId, change.owner, actor);
    return change;
  }
}
