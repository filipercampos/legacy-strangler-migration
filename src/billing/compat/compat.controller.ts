import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseFilters,
} from '@nestjs/common';
import { customerToLegacy, invoiceToLegacy } from '../../acl/outbound';
import type {
  LegacyCustomerDto,
  LegacyCustomerInput,
  LegacyInvoiceDto,
} from '../../legacy/contract';
import { parseLegacyId, TenantId } from '../api/tenant';
import { Clock } from '../clock';
import { BillingRepository } from '../persistence/billing.repository';
import { CustomerWriteService } from './customer-writes.service';
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
    private readonly writes: CustomerWriteService,
  ) {}

  /** Accepted only while modern owns customer writes for the tenant (409 otherwise). */
  @Post()
  async create(
    @TenantId() tenantId: string,
    @Body() body: LegacyCustomerInput,
  ): Promise<LegacyCustomerDto> {
    return this.writes.save(tenantId, null, requireName(body));
  }

  @Put(':id')
  @HttpCode(200)
  async update(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: LegacyCustomerInput,
  ): Promise<LegacyCustomerDto> {
    return this.writes.save(tenantId, parseLegacyId(id), requireName(body));
  }

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
    // Legacy lists invoices of soft-deleted customers too, and returns an empty list (not
    // 404) for unknown customers; preserve both.
    const customer = await this.repository.findCustomerByLegacyId(tenantId, parseLegacyId(id), {
      includeDeleted: true,
    });
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

function requireName(body: LegacyCustomerInput): LegacyCustomerInput {
  if (typeof body?.Name !== 'string' || body.Name.trim() === '') {
    throw new BadRequestException('NAME_REQUIRED');
  }
  return body;
}
