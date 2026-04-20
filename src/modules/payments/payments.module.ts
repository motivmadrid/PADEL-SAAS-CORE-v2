import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { NotificationsProcessor } from './notifications.processor';
import Stripe from 'stripe';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: 'notifications',
    }),
  ],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    NotificationsProcessor,
    {
      provide: 'STRIPE_CLIENT',
      useFactory: () => {
        const key = process.env.STRIPE_SECRET_KEY;
        if (!key) return null; // Stripe disabled in dev when key is absent
        return new Stripe(key, { apiVersion: '2026-03-25.dahlia' });
      },
    },
  ],
})
export class PaymentsModule {}
