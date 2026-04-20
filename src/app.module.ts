import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './modules/users/users.module';
import { ReservationsModule } from './modules/reservations/reservations.module';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsModule } from './modules/payments/payments.module';
import { PricingModule } from './core/pricing/pricing.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { RedisModule } from './core/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';

// DevOps & Security
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { LoggerModule } from 'nestjs-pino';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';

@Module({
  imports: [
    // 1. Observability: Pino Logger Global
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV !== 'production' ? 'debug' : 'info',
        transport: process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined, // JSON crudo en producción para Datadog/ELK
      },
    }),

    // 2. Seguridad: Rate Limiter Distribuido (10 requests por IP cada 60s)
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        storage: new ThrottlerStorageRedisService({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT ?? '6379', 10) || 6379,
        }),
        throttlers: [
          {
            ttl: 60, // 60 segundos
            limit: 10, // Max 10 hits (Anti credential stuffing / booking snipers)
          },
        ],
      }),
    }),

    // 3. APM Bull Queue: Dashboard UI
    BullBoardModule.forRoot({
      route: '/api/queues',
      adapter: ExpressAdapter,
    }),

    RedisModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    ReservationsModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10) || 6379,
      },
    }),
    PaymentsModule,
    PricingModule,
    SchedulerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
