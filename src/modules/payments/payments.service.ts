import { Injectable, BadRequestException, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import Stripe from 'stripe';
import { PaymentMethod } from '@prisma/client';

// Stripe v22 exporta con `export = StripeConstructor`. Con module:nodenext,
// `Stripe` resuelve al namespace StripeConstructor, no a la clase.
// Usamos InstanceType para tipar la instancia inyectada sin ambigüedad.
type StripeInstance = InstanceType<typeof Stripe>;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('notifications') private notificationsQueue: Queue,
    @Inject('STRIPE_CLIENT') private readonly stripe: StripeInstance,
  ) {}

  /**
   * WEBHOOK STRIPE:
   * Verifica la firma con constructEvent antes de procesar cualquier dato.
   * Recibe el raw body y la cabecera stripe-signature.
   */
  async handleStripeWebhook(rawBody: Buffer, signature: string) {
    let event: ReturnType<StripeInstance['webhooks']['constructEvent']>;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET ?? '',
      );
    } catch (err) {
      throw new BadRequestException(`Webhook signature verification failed: ${err.message}`);
    }

    if (event.type !== 'payment_intent.succeeded') return;

    // data.object es tipado como Record<string, unknown> en el evento genérico;
    // lo acotamos al mínimo necesario para esta lógica.
    const paymentIntent = event.data.object as { metadata?: { paymentId?: string } };
    const paymentId = paymentIntent.metadata?.paymentId;
    if (!paymentId) throw new BadRequestException('paymentId no encontrado en metadata del PaymentIntent');

    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.reservationPayment.findUnique({
        where: { id: paymentId },
        include: { reservation: true },
      });

      if (!payment) throw new BadRequestException('Pago no encontrado');
      if (payment.status === 'COMPLETED') return; // Idempotencia

      await tx.reservationPayment.update({
        where: { id: paymentId },
        data: { status: 'COMPLETED' },
      });

      await this.checkAndFinalizeReservation(tx, payment.reservationId, payment.reservation.userId);
    });
  }

  /**
   * Pago desde WALLET (Monedero)
   * Extrae fondo restando, asegura sin valores negativos, marca COMPLETED.
   */
  async payWithWallet(userId: string, paymentId: string) {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.reservationPayment.findUnique({
        where: { id: paymentId },
        include: { reservation: true }
      });

      if (!payment) throw new BadRequestException('Pago no encontrado');
      if (payment.userId !== userId) throw new BadRequestException('Este pago pertenece a otro usuario');
      if (payment.status === 'COMPLETED') throw new BadRequestException('El pago ya fue completado');

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new BadRequestException('Usuario no encontrado');
      if (user.walletBalance < payment.amount) {
        throw new BadRequestException('Saldo insuficiente en tu monedero virtual.');
      }

      await tx.user.update({
        where: { id: userId },
        data: { walletBalance: { decrement: payment.amount } },
      });

      await tx.walletTransaction.create({
        data: {
          userId,
          amount: -payment.amount,
          type: 'WITHDRAW',
          description: `Pago por tramo de reserva ${payment.reservation.id}`,
          referenceId: payment.id,
        }
      });

      await tx.reservationPayment.update({
        where: { id: paymentId },
        data: { status: 'COMPLETED', paymentMethod: PaymentMethod.WALLET },
      });

      await this.checkAndFinalizeReservation(tx, payment.reservationId, userId);
    });

    return { message: 'Pago con wallet completado exitosamente y reserva actualizada.' };
  }

  /**
   * Comprueba si todos los pagos de una reserva suman el precio total.
   * Si es así, marca la reserva como PAID y programa el job de recordatorio.
   */
  private async checkAndFinalizeReservation(
    tx: any,
    reservationId: string,
    userId: string,
  ): Promise<void> {
    const reservation = await tx.reservation.findUnique({
      where: { id: reservationId },
      include: { payments: true },
    });

    const totalPaid = reservation.payments.reduce(
      (sum: number, p: any) => (p.status === 'COMPLETED' ? sum + p.amount : sum),
      0,
    );

    if (totalPaid >= reservation.totalPrice) {
      await tx.reservation.update({
        where: { id: reservation.id },
        data: { status: 'PAID' },
      });

      const delay = reservation.startTime.getTime() - Date.now() - 2 * 60 * 60 * 1000;
      if (delay > 0) {
        await this.notificationsQueue.add(
          'send-reminder',
          { reservationId: reservation.id, userId },
          { delay },
        );
        this.logger.log(`Reminder Job programado para reserva ${reservation.id}`);
      } else {
        this.logger.log(`No se programa Reminder, partido muy cercano`);
      }
    }
  }

  /**
   * PHASE 6: Generador de Recibos en PDF
   */
  async generatePdfReceipt(paymentId: string): Promise<Buffer> {
    const payment = await this.prisma.reservationPayment.findUnique({
      where: { id: paymentId },
      include: {
        reservation: { include: { court: true, user: true } },
        user: true,
      }
    });

    if (!payment) throw new BadRequestException('Pago no encontrado');

    const PDFDocument = require('pdfkit');

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const buffers: Buffer[] = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      doc.fontSize(20).text('TICKET DE RESERVA - PADEL SAAS', { align: 'center' });
      doc.moveDown();

      doc.fontSize(12).text(`ID Referencia: ${payment.id}`);
      doc.text(`Fecha Emisión: ${new Date().toISOString()}`);
      doc.text(`Estado del Pago: ${payment.status}`);
      doc.moveDown();

      doc.fontSize(14).text('Detalles del Partido:', { underline: true });
      doc.fontSize(12).text(`Pista: ${payment.reservation.court.name}`);
      doc.text(`Inicio Hora Local: ${payment.reservation.startTime.toLocaleString()}`);
      doc.moveDown();

      doc.fontSize(14).text('Detalles del Pagador:', { underline: true });
      doc.fontSize(12).text(`Nombre: ${payment.user.firstName} ${payment.user.lastName}`);
      doc.text(`Email: ${payment.user.email}`);
      doc.moveDown();

      doc.fontSize(16).text(`TOTAL PAGADO: ${(payment.amount / 100).toFixed(2)} EUR`, { align: 'right' });

      doc.end();
    });
  }

  /**
   * Recarga el monedero virtual del usuario.
   * @param userId  ID del usuario autenticado
   * @param amount  Importe en CENTAVOS (ej. 5000 = 50 EUR)
   */
  async rechargeWallet(userId: string, amount: number) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('El importe debe ser un entero positivo en centavos');
    }

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: { walletBalance: { increment: amount } },
        select: { id: true, email: true, walletBalance: true },
      });

      await tx.walletTransaction.create({
        data: {
          userId,
          amount,
          type: 'DEPOSIT',
          description: `Recarga de monedero: ${(amount / 100).toFixed(2)} EUR`,
        },
      });

      return { walletBalance: user.walletBalance, recharged: amount };
    });
  }
}
