import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../../billing/domain/errors';

const LEGACY_CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'INVALID_REQUEST',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
};

/** Compat endpoints answer errors the way the legacy app does: `{ "error": "NOT_FOUND" }`. */
@Catch()
export class LegacyErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(LegacyErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    if (exception instanceof HttpException) status = exception.getStatus();
    else if (exception instanceof DomainError) {
      status = exception.code === 'invalid_value' ? HttpStatus.BAD_REQUEST : HttpStatus.CONFLICT;
    } else this.logger.error({ err: exception }, 'unhandled compat error');
    if (exception instanceof HttpException && status === 400) {
      const message = exception.message;
      if (message.includes('X-Tenant-Id')) {
        response.status(status).json({ error: 'INVALID_TENANT' });
        return;
      }
      if (message.includes('invalid id')) {
        response.status(status).json({ error: 'INVALID_ID' });
        return;
      }
    }
    response.status(status).json({ error: LEGACY_CODES[status] ?? 'INTERNAL' });
  }
}
