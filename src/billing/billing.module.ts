import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { billingEnvSchema } from '../shared/config/env';
import { CoreModule } from '../shared/nest/core.module';
import { ProblemDetailsFilter } from '../shared/nest/problem-details.filter';
import { V2Controller } from './api/v2.controller';
import { Clock } from './clock';
import { BillingRepository } from './persistence/billing.repository';

@Module({
  imports: [CoreModule.forRoot('billing-service', billingEnvSchema)],
  controllers: [V2Controller],
  providers: [BillingRepository, Clock, { provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class BillingModule {}
