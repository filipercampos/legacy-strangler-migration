import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { TENANT_HEADER } from '../../legacy/contract';

/** Tenant code from X-Tenant-Id (set by the gateway from the caller's credentials). */
export const TenantId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const value = context.switchToHttp().getRequest<Request>().header(TENANT_HEADER);
  if (!value || !/^[A-Z0-9]{1,10}$/.test(value)) {
    throw new BadRequestException('missing or invalid X-Tenant-Id');
  }
  return value;
});

export function parseLegacyId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) {
    throw new BadRequestException('invalid id');
  }
  return id;
}
