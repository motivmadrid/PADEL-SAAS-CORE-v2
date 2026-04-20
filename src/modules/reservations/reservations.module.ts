import { Module } from '@nestjs/common';
import { ReservationsController, CourtsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PricingModule } from '../../core/pricing/pricing.module';

@Module({
  imports: [PrismaModule, PricingModule],
  controllers: [ReservationsController, CourtsController],
  providers: [ReservationsService]
})
export class ReservationsModule {}
