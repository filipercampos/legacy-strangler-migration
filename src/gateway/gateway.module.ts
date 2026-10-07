import { Module } from '@nestjs/common';
import { gatewayEnvSchema } from '../shared/config/env';
import { CoreModule } from '../shared/nest/core.module';
import { AdminController } from './admin.controller';
import { FacadeController } from './facade.controller';
import { FlagStore } from './flag-store';
import { UpstreamClient } from './upstream';

@Module({
  imports: [CoreModule.forRoot('strangler-gateway', gatewayEnvSchema)],
  controllers: [AdminController, FacadeController],
  providers: [FlagStore, UpstreamClient],
})
export class GatewayModule {}
