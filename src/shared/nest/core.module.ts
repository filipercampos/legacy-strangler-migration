import {
  Controller,
  type DynamicModule,
  Get,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HealthCheck, HealthCheckService, TerminusModule } from '@nestjs/terminus';
import { type Kysely, sql } from 'kysely';
import { LoggerModule } from 'nestjs-pino';
import type { z } from 'zod';
import { loadEnv } from '../config/env';
import { createDatabase } from '../database/database';
import type { Database } from '../database/schema';
import { httpLoggerOptions } from '../observability/logging';
import { DB, ENV } from './tokens';

interface CoreEnv {
  DATABASE_URL: string;
  DATABASE_POOL_MAX: number;
  LOG_LEVEL: string;
}

@Controller('health')
class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(DB) private readonly db: Kysely<Database>,
  ) {}

  /** Liveness: never checks dependencies (avoids restart storms when the DB blips). */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      async () => {
        await sql`SELECT 1`.execute(this.db);
        return { postgres: { status: 'up' } };
      },
    ]);
  }
}

class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Kysely<Database>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

/**
 * Typed env, PostgreSQL (Kysely), pino request logging with request ids, and health probes:
 * the plumbing every Nest process in this repo shares.
 */
@Global()
@Module({})
export class CoreModule {
  static forRoot<S extends z.ZodType<CoreEnv, z.ZodTypeDef, unknown>>(
    service: string,
    schema: S,
  ): DynamicModule {
    const env = loadEnv(schema) as CoreEnv;
    return {
      module: CoreModule,
      imports: [
        TerminusModule,
        LoggerModule.forRoot({ pinoHttp: httpLoggerOptions(service, env.LOG_LEVEL) }),
      ],
      controllers: [HealthController],
      providers: [
        { provide: ENV, useValue: env },
        {
          provide: DB,
          useFactory: () =>
            createDatabase({
              connectionString: env.DATABASE_URL,
              poolMax: env.DATABASE_POOL_MAX,
              applicationName: service,
            }),
        },
        DatabaseLifecycle,
      ],
      exports: [ENV, DB],
    };
  }
}
