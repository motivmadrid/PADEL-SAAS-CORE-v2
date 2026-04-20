import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { ReservationStatus, PaymentStatus } from '@prisma/client';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  // Tiempo máximo que una reserva puede estar en PENDING antes de expirar.
  // Debe coincidir con el TTL del Redis lock (LOCK_TTL_MS en RedisLockService).
  private readonly PENDING_TTL_MS = 10 * 60 * 1000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Se ejecuta cada 5 minutos.
   *
   * Busca reservas PENDING cuyo createdAt supera PENDING_TTL_MS y las cancela
   * junto con todos sus ReservationPayments pendientes, en una única transacción
   * atómica para evitar estados inconsistentes.
   *
   * Los payments en estado COMPLETED o FAILED no se tocan: un pago que llegó
   * pero cuya reserva no completó el split se deja para reconciliación manual.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cleanupExpiredReservations(): Promise<void> {
    const cutoff = new Date(Date.now() - this.PENDING_TTL_MS);

    try {
      await this.prisma.$transaction(async (tx) => {
        // 1. Identificar reservas expiradas — solo SELECT ligero con IDs
        const expired = await tx.reservation.findMany({
          where: {
            status: ReservationStatus.PENDING,
            createdAt: { lt: cutoff },
          },
          select: { id: true },
        });

        if (expired.length === 0) {
          this.logger.debug('Cleanup: no hay reservas PENDING expiradas');
          return;
        }

        const ids = expired.map((r) => r.id);

        // 2. Cancelar los ReservationPayments PENDING asociados.
        //    COMPLETED/FAILED se dejan intactos para auditoría y reconciliación.
        const { count: paymentsUpdated } = await tx.reservationPayment.updateMany({
          where: {
            reservationId: { in: ids },
            status: PaymentStatus.PENDING,
          },
          data: { status: PaymentStatus.FAILED },
        });

        // 3. Cancelar las reservas en un único batch
        await tx.reservation.updateMany({
          where: { id: { in: ids } },
          data: { status: ReservationStatus.CANCELLED },
        });

        this.logger.log(
          `Cleanup: ${expired.length} reserva(s) expirada(s) canceladas, ` +
          `${paymentsUpdated} pago(s) PENDING liberados`,
        );
      });
    } catch (err) {
      // No relanzar: un fallo del job no debe derribar el proceso
      this.logger.error(`Cleanup: error durante la limpieza de reservas expiradas`, err.stack);
    }
  }
}
