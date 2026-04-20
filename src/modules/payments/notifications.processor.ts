import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Processor('notifications')
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    switch (job.name) {
      case 'send-reminder':
        return this.handleSendReminder(job.data);
      case 'send-reset-password':
        return this.handleSendResetPassword(job.data);
      default:
        this.logger.warn(`Job ${job.name} no soportado`);
    }
  }

  private async handleSendResetPassword(data: { email: string, token: string }) {
    this.logger.log(`=== EMAIL SIMULATION ===`);
    this.logger.log(`Enviando ENLACE RECUPERACIÓN a [${data.email}]`);
    this.logger.log(`Enlace seguro: https://app.padelsaas.com/reset-password?token=${data.token}`);
    this.logger.log(`========================`);
  }

  private async handleSendReminder(data: { reservationId: string, userId: string }) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: data.reservationId },
      include: {
        court: true,
        user: true,
      }
    });

    if (!reservation) {
      this.logger.error(`Reserva ${data.reservationId} no encontrada para el recordatorio`);
      return;
    }

    if (reservation.status !== 'PAID') {
      this.logger.log(`Reserva ${reservation.id} fue cancelada. Se omite el recordatorio.`);
      return;
    }

    const { user, court, startTime } = reservation;

    // Simulación de envío realista
    this.logger.log(`=== EMAIL SIMULATION ===`);
    this.logger.log(`Enviando recordatorio a [${user.email}] para su partido en [${court.name}] a las [${startTime.toISOString()}]`);
    this.logger.log(`========================`);
  }
}
