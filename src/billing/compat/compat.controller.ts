import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Query,
  UseFilters,
} from '@nestjs/common';
import { customerToLegacy, invoiceToLegacy } from '../../acl/outbound';
import type { LegacyCustomerDto, LegacyInvoiceDto } from '../../legacy/contract';
import { parseLegacyId, TenantId } from '../api/tenant';
import { Clock } from '../clock';
import { BillingRepository } from '../persistence/billing.repository';
import { LegacyErrorFilter } from './legacy-error.filter';

/**
 * Legacy-compatible endpoints served from the modern model through the outbound ACL. The
 * gateway can route any of these paths here instead of to the legacy app without callers
 * noticing. This controller is temporary: it is deleted when the last caller moves to /v2.
 */
@Controller('api/customers')
@UseFilters(LegacyErrorFilter)
export class CompatController {
  constructor(
    private readonly repository: BillingRepository,
    private readonly clock: Clock,
  ) {}

  @Get()
  async list(
    @TenantId() tenantId: string,
    @Query('after') after?: string,
    @Query('top') top?: string,
  ): Promise<{ Items: LegacyCustomerDto[] }> {
    const page = await this.repository.listCustomers(
      tenantId,
      Number(after ?? 0) || 0,
      Math.min(Number(top ?? 50) || 50, 200),
    );
    return { Items: page.map((customer) => customerToLegacy(customer.snapshot)) };
  }

  @Get(':id')
  @HttpCode(200)
  async get(@TenantId() tenantId: string, @Param('id') id: string): Promise<LegacyCustomerDto> {
    const customer = await this.repository.findCustomerByLegacyId(tenantId, parseLegacyId(id));
    if (!customer) throw new NotFoundException();
    return customerToLegacy(customer.snapshot);
  }

  @Get(':id/invoices')
  async invoices(
    @TenantId() tenantId: string,
    @Param('id') id: string,
  ): Promise<{ Items: LegacyInvoiceDto[] }> {
    const customer = await this.repository.findCustomerByLegacyId(tenantId, parseLegacyId(id));
    // Legacy returns an empty list (not 404) for unknown customers; preserve that.
    if (!customer) return { Items: [] };
    const snapshot = customer.snapshot;
    const today = this.clock.today();
    const invoices = await this.repository.listInvoices(snapshot.id);
    return {
      Items: invoices.map((invoice) =>
        invoiceToLegacy(
          invoice.snapshot,
          { legacyId: snapshot.legacyId, name: snapshot.name },
          today,
        ),
      ),
    };
  }
}
