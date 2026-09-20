import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '../../billing/domain/errors';

interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

const DOMAIN_STATUS: Record<string, number> = {
  invalid_value: HttpStatus.UNPROCESSABLE_ENTITY,
  invalid_transition: HttpStatus.CONFLICT,
  not_entity_owner: HttpStatus.CONFLICT,
};

/** RFC 9457 problem details for the v2 API. Internal errors never leak details. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const problem = toProblem(exception);
    problem.instance = request.originalUrl;
    if (problem.status >= 500) {
      this.logger.error({ err: exception, path: request.originalUrl }, 'unhandled error');
    }
    response.status(problem.status).type('application/problem+json').json(problem);
  }
}

function toProblem(exception: unknown): ProblemDetails {
  if (exception instanceof DomainError) {
    const status = DOMAIN_STATUS[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY;
    return { type: exception.code, title: exception.name, status, detail: exception.message };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { type: 'about:blank', title: exception.message, status };
  }
  return { type: 'about:blank', title: 'Internal Server Error', status: 500 };
}
