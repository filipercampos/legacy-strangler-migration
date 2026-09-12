import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options } from 'pino-http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accept the caller's request id when it is sane, otherwise mint one. */
export function resolveRequestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && /^[\w.:-]{1,128}$/.test(header) ? header : randomUUID();
}

/**
 * pino-http options shared by every process (legacy Express app and the Nest apps), so logs
 * from both sides of a shadow read can be joined on the same request id.
 */
export function httpLoggerOptions(service: string, level: string): Options {
  return {
    level,
    base: { service },
    genReqId: (request: IncomingMessage, response: ServerResponse) => {
      const id = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
      response.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-admin-token"]'],
    autoLogging: { ignore: (request) => request.url?.startsWith('/health') ?? false },
    transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  };
}
