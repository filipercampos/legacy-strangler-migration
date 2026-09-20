import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Clock } from '../clock';
import { BillingRepository } from '../persistence/billing.repository';
import { TenantId } from './tenant';
import { presentCustomer, presentInvoice } from './v2.presenter';

/** The clean API new callers integrate with. Ids are UUIDs; legacy ids are informational. */
@Controller('v2/customers')
export class V2Controller {
  constructor(
    private readonly repository: BillingRepository,
    private readonly clock: Clock,
  ) {}

  @Get()
  async list(
    @TenantId() tenantId: string,
    @Query('afterLegacyId') after?: string,
    @Query('limit') limit?: string,
  ) {
    const page = await this.repository.listCustomers(
      tenantId,
      Number(after ?? 0) || 0,
      Math.min(Number(limit ?? 50) || 50, 200),
    );
    return { items: page.map((customer) => presentCustomer(customer.snapshot)) };
  }

  @Get(':id')
  async get(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    const customer = await this.repository.findCustomerById(tenantId, id);
    if (!customer) throw new NotFoundException('customer not found');
    return presentCustomer(customer.snapshot);
  }

  @Get(':id/invoices')
  async invoices(@TenantId() tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    const customer = await this.repository.findCustomerById(tenantId, id);
    if (!customer) throw new NotFoundException('customer not found');
    const today = this.clock.today();
    const invoices = await this.repository.listInvoices(id);
    return { items: invoices.map((invoice) => presentInvoice(invoice.snapshot, today)) };
  }
}
