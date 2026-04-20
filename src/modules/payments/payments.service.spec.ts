import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../prisma/prisma.service';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Devuelve un mock tx con los métodos que usa checkAndFinalizeReservation */
function buildMockTx(reservationData: Partial<{
  id: string;
  totalPrice: number;
  startTime: Date;
  payments: { id: string; status: string; amount: number }[];
  userId: string;
}> = {}) {
  const reservation = {
    id: 'res-1',
    totalPrice: 100,
    startTime: new Date(Date.now() + 3 * 60 * 60 * 1000), // 3 h en el futuro
    payments: [{ id: 'pay-1', status: 'COMPLETED', amount: 100 }],
    userId: 'user-1',
    ...reservationData,
  };

  return {
    reservation: {
      findUnique: jest.fn().mockResolvedValue(reservation),
      update: jest.fn().mockResolvedValue(reservation),
    },
  };
}

/** Construye un Stripe.Event falso de tipo payment_intent.succeeded */
function buildStripeEvent(paymentId?: string) {
  return {
    type: 'payment_intent.succeeded',
    data: {
      object: {
        metadata: paymentId !== undefined ? { paymentId } : {},
      },
    },
  };
}

// ─── Suite principal ─────────────────────────────────────────────────────────

describe('PaymentsService', () => {
  let service: PaymentsService;
  let mockPrisma: { $transaction: jest.Mock };
  let mockQueue: { add: jest.Mock };
  let mockStripe: { webhooks: { constructEvent: jest.Mock } };

  beforeEach(async () => {
    mockPrisma = { $transaction: jest.fn() };
    mockQueue = { add: jest.fn().mockResolvedValue(undefined) };
    mockStripe = { webhooks: { constructEvent: jest.fn() } };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: getQueueToken('notifications'), useValue: mockQueue },
        { provide: 'STRIPE_CLIENT', useValue: mockStripe },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  // ── handleStripeWebhook ────────────────────────────────────────────────────

  describe('handleStripeWebhook', () => {
    const rawBody = Buffer.from('{"type":"payment_intent.succeeded"}');
    const signature = 'whsec_test_signature';

    it('lanza BadRequestException cuando la firma de Stripe es inválida', async () => {
      mockStripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature for payload');
      });

      await expect(service.handleStripeWebhook(rawBody, signature)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.handleStripeWebhook(rawBody, signature)).rejects.toThrow(
        'Webhook signature verification failed',
      );
    });

    it('incluye el mensaje de Stripe en la excepción para facilitar el diagnóstico', async () => {
      const stripeMessage = 'Timestamp outside the tolerance zone';
      mockStripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error(stripeMessage);
      });

      await expect(service.handleStripeWebhook(rawBody, signature)).rejects.toThrow(
        stripeMessage,
      );
    });

    it('no procesa nada si el tipo de evento no es payment_intent.succeeded', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue({ type: 'charge.refunded', data: {} });

      await service.handleStripeWebhook(rawBody, signature);

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('lanza BadRequestException si el evento no contiene paymentId en metadata', async () => {
      // buildStripeEvent() sin argumento → metadata: {} → paymentId undefined
      mockStripe.webhooks.constructEvent.mockReturnValue(buildStripeEvent());

      await expect(service.handleStripeWebhook(rawBody, signature)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.handleStripeWebhook(rawBody, signature)).rejects.toThrow(
        'paymentId no encontrado en metadata',
      );
      // El throw ocurre antes de entrar en $transaction
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('lanza BadRequestException si el pago no existe en base de datos', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(buildStripeEvent('pay-ghost'));

      const mockTx = {
        reservationPayment: {
          findUnique: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) =>
        cb(mockTx),
      );

      await expect(service.handleStripeWebhook(rawBody, signature)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.handleStripeWebhook(rawBody, signature)).rejects.toThrow(
        'Pago no encontrado',
      );
    });

    it('no actualiza el pago si ya está COMPLETED (idempotencia)', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(buildStripeEvent('pay-1'));

      const mockTx = {
        reservationPayment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pay-1',
            status: 'COMPLETED',
            reservationId: 'res-1',
            reservation: { userId: 'user-1' },
          }),
          update: jest.fn(),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) =>
        cb(mockTx),
      );

      await service.handleStripeWebhook(rawBody, signature);

      expect(mockTx.reservationPayment.update).not.toHaveBeenCalled();
    });

    it('marca el pago como COMPLETED e invoca checkAndFinalizeReservation', async () => {
      mockStripe.webhooks.constructEvent.mockReturnValue(buildStripeEvent('pay-1'));

      const mockTx = {
        reservationPayment: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'pay-1',
            status: 'PENDING',
            reservationId: 'res-1',
            reservation: { userId: 'user-1' },
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) =>
        cb(mockTx),
      );

      const finalizeSpy = jest
        .spyOn(service as any, 'checkAndFinalizeReservation')
        .mockResolvedValue(undefined);

      await service.handleStripeWebhook(rawBody, signature);

      expect(mockTx.reservationPayment.update).toHaveBeenCalledWith({
        where: { id: 'pay-1' },
        data: { status: 'COMPLETED' },
      });
      expect(finalizeSpy).toHaveBeenCalledWith(mockTx, 'res-1', 'user-1');
    });
  });

  // ── checkAndFinalizeReservation ───────────────────────────────────────────

  describe('checkAndFinalizeReservation (método privado)', () => {
    // Acceso explícito al método privado para poder testearlo directamente
    const callFinalize = (
      tx: any,
      reservationId = 'res-1',
      userId = 'user-1',
    ) => (service as any).checkAndFinalizeReservation(tx, reservationId, userId);

    it('no actualiza la reserva ni encola job si la suma de pagos < totalPrice', async () => {
      const mockTx = buildMockTx({
        totalPrice: 200,
        payments: [
          { id: 'pay-1', status: 'COMPLETED', amount: 100 },
          { id: 'pay-2', status: 'PENDING', amount: 100 },
        ],
      });

      await callFinalize(mockTx);

      expect(mockTx.reservation.update).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('no suma pagos con status distinto de COMPLETED', async () => {
      const mockTx = buildMockTx({
        totalPrice: 100,
        payments: [
          { id: 'pay-1', status: 'FAILED', amount: 100 },
          { id: 'pay-2', status: 'PENDING', amount: 100 },
        ],
      });

      await callFinalize(mockTx);

      expect(mockTx.reservation.update).not.toHaveBeenCalled();
    });

    it('actualiza la reserva a PAID cuando totalPaid >= totalPrice', async () => {
      const mockTx = buildMockTx({
        id: 'res-1',
        totalPrice: 100,
        payments: [{ id: 'pay-1', status: 'COMPLETED', amount: 100 }],
      });

      await callFinalize(mockTx);

      expect(mockTx.reservation.update).toHaveBeenCalledWith({
        where: { id: 'res-1' },
        data: { status: 'PAID' },
      });
    });

    it('encola el job de recordatorio cuando el partido es > 2 h en el futuro', async () => {
      const futureTime = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 h
      const mockTx = buildMockTx({
        id: 'res-1',
        totalPrice: 50,
        startTime: futureTime,
        payments: [{ id: 'pay-1', status: 'COMPLETED', amount: 50 }],
      });

      await callFinalize(mockTx, 'res-1', 'user-42');

      expect(mockQueue.add).toHaveBeenCalledWith(
        'send-reminder',
        { reservationId: 'res-1', userId: 'user-42' },
        expect.objectContaining({ delay: expect.any(Number) }),
      );

      // El delay debe ser positivo y aproximadamente 2h antes del partido
      const { delay } = mockQueue.add.mock.calls[0][2];
      expect(delay).toBeGreaterThan(0);
    });

    it('NO encola el job cuando el partido está a menos de 2 h', async () => {
      const nearFuture = new Date(Date.now() + 30 * 60 * 1000); // 30 min
      const mockTx = buildMockTx({
        totalPrice: 50,
        startTime: nearFuture,
        payments: [{ id: 'pay-1', status: 'COMPLETED', amount: 50 }],
      });

      await callFinalize(mockTx);

      expect(mockTx.reservation.update).toHaveBeenCalled(); // sí se marca PAID
      expect(mockQueue.add).not.toHaveBeenCalled();         // pero sin reminder
    });

    it('dispara correctamente con pagos múltiples que suman exactamente totalPrice', async () => {
      const mockTx = buildMockTx({
        id: 'res-split',
        totalPrice: 150,
        payments: [
          { id: 'pay-a', status: 'COMPLETED', amount: 75 },
          { id: 'pay-b', status: 'COMPLETED', amount: 75 },
        ],
      });

      await callFinalize(mockTx, 'res-split', 'user-1');

      expect(mockTx.reservation.update).toHaveBeenCalledWith({
        where: { id: 'res-split' },
        data: { status: 'PAID' },
      });
    });
  });
});
