import { Controller, Post, Param, UseGuards, Request, Get, Res, Req, Headers, BadRequestException, Body } from '@nestjs/common';
import type { Response } from 'express';

// Interfaz mínima local para tipar req.rawBody sin depender del tipo express
// en la firma del decorador (requerimiento de emitDecoratorMetadata + isolatedModules)
interface RawBodyRequest {
  rawBody?: Buffer;
}
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Webhook público. Stripe enviaría un Post aquí (Sin AuthGuard pero con validación de Signature en producción)
   */
  @Post('webhook/stripe')
  async handleStripeWebhook(
    @Req() req: RawBodyRequest,
    @Headers('stripe-signature') signature: string,
  ) {
    // rawBody puede ser undefined si el cliente no envía body; lanzar 400 antes de llegar al servicio
    if (!req.rawBody) throw new BadRequestException('Missing raw body');
    await this.paymentsService.handleStripeWebhook(req.rawBody, signature);
    return { received: true };
  }

  /**
   * Endpoints protegidos para pago iterativo y con Monedero Virtual
   */
  @UseGuards(JwtAuthGuard)
  @Post('wallet/recharge')
  async rechargeWallet(@Body() body: { amount: number }, @Request() req) {
    return this.paymentsService.rechargeWallet(req.user.id, body.amount);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':paymentId/wallet')
  async payWithWallet(@Param('paymentId') paymentId: string, @Request() req) {
    return this.paymentsService.payWithWallet(req.user.id, paymentId);
  }

  // == PHASE 6: Ticketing PDF ==
  @Get(':paymentId/receipt')
  async downloadReceipt(@Param('paymentId') paymentId: string, @Res() res: Response) {
    const buffer = await this.paymentsService.generatePdfReceipt(paymentId);
    
    // Devolver un PDF renderizado en memoria sin tocar Disco
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Ticket_${paymentId}.pdf"`,
      'Content-Length': buffer.length,
    });
    
    res.end(buffer);
  }
}
