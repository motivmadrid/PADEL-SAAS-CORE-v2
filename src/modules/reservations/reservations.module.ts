import { Module } from '@nestjs/common';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PricingModule } from '../../core/pricing/pricing.module';

@Module({
  imports: [PrismaModule, PricingModule],
  controllers: [ReservationsController],
  providers: [ReservationsService]
})
export class ReservationsModule {}
