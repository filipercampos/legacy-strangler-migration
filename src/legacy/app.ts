import express, { type NextFunction, type Request, type Response } from 'express';
import sql from 'mssql';
import { pinoHttp } from 'pino-http';
import { httpLoggerOptions } from '../shared/observability/logging';
import {
  type LegacyCustomerInput,
  type LegacyCustomerRow,
  type LegacyInvoiceRow,
  TENANT_HEADER,
  toLegacyCustomerDto,
  toLegacyInvoiceDto,
} from './contract';

/**
 * The "legacy" application: a thin Express layer over stored procedures, kept deliberately
 * close to what the real one does (no domain model, validation by the database, error
 * numbers from THROW mapped to HTTP codes).
 */
export function createLegacyApp(pool: sql.ConnectionPool, logLevel = 'info'): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(pinoHttp(httpLoggerOptions('legacy-billing', logLevel)));

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    try {
      await pool.request().query('SELECT 1 AS ok');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  const tenant = (req: Request): string => {
    const value = req.header(TENANT_HEADER);
    if (!value || !/^[A-Z0-9]{1,10}$/.test(value)) throw new HttpError(400, 'INVALID_TENANT');
    return value;
  };
  const intParam = (value: string | undefined): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new HttpError(400, 'INVALID_ID');
    return parsed;
  };

  app.get('/api/customers', async (req, res) => {
    const result = await pool
      .request()
      .input('CoCode', sql.NVarChar(10), tenant(req))
      .input('AfterId', sql.Int, Number(req.query.after ?? 0) || 0)
      .input('Top', sql.Int, Math.min(Number(req.query.top ?? 50) || 50, 200))
      .execute<LegacyCustomerRow>('dbo.usp_ListCustomers');
    res.json({ Items: result.recordset.map(toLegacyCustomerDto) });
  });

  app.get('/api/customers/:id', async (req, res) => {
    const result = await pool
      .request()
      .input('CustId', sql.Int, intParam(req.params.id))
      .input('CoCode', sql.NVarChar(10), tenant(req))
      .execute<LegacyCustomerRow>('dbo.usp_GetCustomer');
    const row = result.recordset[0];
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    res.json(toLegacyCustomerDto(row));
  });

  const saveCustomer = async (req: Request, res: Response, id: number | null) => {
    const body = req.body as Partial<LegacyCustomerInput>;
    if (typeof body.Name !== 'string' || body.Name.trim() === '') {
      throw new HttpError(400, 'NAME_REQUIRED');
    }
    const result = await pool
      .request()
      .input('CustId', sql.Int, id)
      .input('CoCode', sql.NVarChar(10), tenant(req))
      .input('Name', sql.NVarChar(200), body.Name)
      .input('Email', sql.NVarChar(200), body.Email ?? null)
      .input('Doc', sql.NVarChar(20), body.Doc ?? null)
      .input('Stat', sql.Char(1), body.Status ?? 'A')
      .input('City', sql.NVarChar(100), body.City ?? null)
      .input('Uf', sql.Char(2), body.Uf ?? null)
      .input('PlanCd', sql.NVarChar(20), body.Plan ?? null)
      .input('PlanPrice', sql.Money, body.PlanPrice ?? null)
      .execute<LegacyCustomerRow>('dbo.usp_SaveCustomer');
    const row = result.recordset[0];
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    res.status(id === null ? 201 : 200).json(toLegacyCustomerDto(row));
  };

  app.post('/api/customers', (req, res) => saveCustomer(req, res, null));
  app.put('/api/customers/:id', (req, res) => saveCustomer(req, res, intParam(req.params.id)));

  app.get('/api/customers/:id/invoices', async (req, res) => {
    const result = await pool
      .request()
      .input('CustId', sql.Int, intParam(req.params.id))
      .input('CoCode', sql.NVarChar(10), tenant(req))
      .execute<LegacyInvoiceRow>('dbo.usp_GetCustomerInvoices');
    res.json({ Items: result.recordset.map(toLegacyInvoiceDto) });
  });

  app.post('/api/invoices/:id/pay', async (req, res) => {
    const payDate = (req.body as { PayDate?: string }).PayDate ?? null;
    if (payDate !== null && !/^\d{8}$/.test(payDate)) throw new HttpError(400, 'INVALID_DATE');
    const result = await pool
      .request()
      .input('InvId', sql.Int, intParam(req.params.id))
      .input('CoCode', sql.NVarChar(10), tenant(req))
      .input('PayDt', sql.NVarChar(8), payDate)
      .execute<LegacyInvoiceRow>('dbo.usp_PayInvoice');
    const row = result.recordset[0];
    if (!row) throw new HttpError(404, 'NOT_FOUND');
    res.json(toLegacyInvoiceDto(row));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  });

  // Express 5 forwards rejected promises from async handlers here.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.code });
      return;
    }
    // THROW 50404 / 50409 inside the procedures carry the HTTP meaning in the error number.
    const number = (error as { number?: number }).number;
    if (number === 50404) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (number === 50409) {
      res.status(409).json({ error: 'CONFLICT' });
      return;
    }
    req.log.error({ err: error }, 'unhandled legacy error');
    res.status(500).json({ error: 'INTERNAL' });
  });

  return app;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
