import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisLockService } from '../../core/redis/redis-lock.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { PricingService } from '../../core/pricing/pricing.service';
import { addWeeks } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';
import { CourtType } from '@prisma/client';

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisLock: RedisLockService,
    private readonly pricingService: PricingService,
  ) {}

  async getAvailability(courtId: string, dateStr: string) {
    const startOfDay = new Date(dateStr);
    const endOfDay = new Date(dateStr);
    endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

    const dbReservations = await this.prisma.reservation.findMany({
      where: {
        courtId,
        startTime: { gte: startOfDay, lt: endOfDay },
        status: { in: ['PAID', 'PENDING'] },
      },
      select: { startTime: true, endTime: true, status: true },
    });

    const redisLocks = await this.redisLock.getActiveLocks(courtId);

    return {
      date: dateStr,
      bookedInDb: dbReservations,
      lockedInRedis: redisLocks, 
    };
  }

  async initiateReservation(userId: string, dto: CreateReservationDto, overrideGroupId?: string) {
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);
    const timeSlotStr = `${startTime.toISOString()}_${endTime.toISOString()}`;
    
    const lockAcquired = await this.redisLock.acquireLock(dto.courtId, timeSlotStr, userId);
    
    if (!lockAcquired) {
      throw new BadRequestException('La pista ha sido seleccionada por otro usuario en este instante.');
    }

    const court = await this.prisma.court.findUnique({ where: { id: dto.courtId } });
    if (!court) throw new BadRequestException('La pista no existe.');

    // PHASE 6: Calcular precio dinámico con el Pricing Engine
    const computedPrice = this.pricingService.calculateDynamicPrice(
      startTime,
      court.pricePerHour,
      court.peakPriceMultiplier,
      court.offPeakPriceMultiplier
    );

    const reservation = await this.prisma.reservation.create({
      data: {
        courtId: dto.courtId,
        userId: userId,
        startTime: startTime,
        endTime: endTime,
        isPublic: dto.isPublic || false,
        status: 'PENDING',
        totalPrice: computedPrice,
        recurringGroupId: overrideGroupId || null, // PHASE 6: Asignación de serie en bloque
        payments: {
          create: {
            userId: userId, 
            amount: computedPrice, 
            status: 'PENDING'
          }
        }
      },
      include: { payments: true }
    });

    return {
      message: 'Pista bloqueada temporalmente. Tienes 10 minutos para completar el pago.',
      reservationId: reservation.id,
      paymentId: reservation.payments[0].id,
      amountToPay: computedPrice,
    };
  }

  /**
   * PHASE 6: Lluvia y Cancelaciones
   */
  async cancelWeather(dateStr: string, courtType: string) {
    const startOfDay = new Date(dateStr);
    const endOfDay = new Date(dateStr);
    endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

    await this.prisma.$transaction(async (tx) => {
      // 1. Obtener afectados (solo PENDING o PAID)
      const affected = await tx.reservation.findMany({
        where: {
          startTime: { gte: startOfDay, lt: endOfDay },
          status: { in: ['PAID', 'PENDING'] },
          court: { type: courtType as CourtType }
        },
        include: { payments: true, user: true, court: true }
      });

      this.logger.log(`Cancelando ${affected.length} reservas por lluvia en pistas ${courtType}.`);

      for (const res of affected) {
        // 2. Marcar Cancelado
        await tx.reservation.update({
          where: { id: res.id },
          data: { status: 'CANCELLED' }
        });

        // 3. Reembolsar a Wallet a cada jugador que ya haya aportado capital (COMPLETED)
        for (const payment of res.payments) {
          if (payment.status === 'COMPLETED') {
            await tx.reservationPayment.update({
              where: { id: payment.id },
              data: { status: 'REFUNDED' }
            });

            await tx.walletTransaction.create({
              data: {
                userId: payment.userId,
                amount: payment.amount,
                type: 'REFUND',
                description: `Reembolso por Lluvia - Pista ${res.court.name}`,
                referenceId: res.id,
              }
            });

            await tx.user.update({
              where: { id: payment.userId },
              data: { walletBalance: { increment: payment.amount } }
            });
          }
        }
      }
    });

    return { message: 'Lluvia tramitada: Citas canceladas y monederos devueltos exitosamente.' };
  }

  /**
   * PHASE 6: Generación Masiva (Recurring)
   */
  async createRecurringReservations(userId: string, body: { courtId: string, baseStartDate: string, endDate: string, durationMinutes: number }) {
    const start = new Date(body.baseStartDate);
    const end = new Date(body.endDate);
    const groupId = uuidv4();

    let current = start;
    const generated: Array<{ message: string; reservationId: string; paymentId: string; amountToPay: number }> = [];
    const unavailable: string[] = [];

    // Iteramos por semanas hasta end date
    while (current <= end) {
      const iterEnd = new Date(current.getTime() + body.durationMinutes * 60000);
      
      const isFree = await this.checkIfFree(body.courtId, current, iterEnd);
      if (isFree) {
        const dto: CreateReservationDto = {
          courtId: body.courtId,
          startTime: current.toISOString(),
          endTime: iterEnd.toISOString(),
          isPublic: false,
        };

        const result = await this.initiateReservation(userId, dto, groupId);
        generated.push(result);
      } else {
        unavailable.push(current.toISOString());
      }
      
      current = addWeeks(current, 1);
    }

    return {
      message: 'Proceso recurrente finalizado.',
      recurringGroupId: groupId,
      createdCount: generated.length,
      unavailableDatesSkipped: unavailable,
    };
  }

  private async checkIfFree(courtId: string, st: Date, en: Date): Promise<boolean> {
    const hit = await this.prisma.reservation.findFirst({
      where: {
        courtId,
        status: { in: ['PAID', 'PENDING'] },
        OR: [
          { startTime: { lt: en }, endTime: { gt: st } }
        ]
      }
    });
    return hit === null; // Si no hay choque, está libre (saltamos Redis lock por simplicity en admin)
  }
}
