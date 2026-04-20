import { Injectable } from '@nestjs/common';
import { getDay, getHours } from 'date-fns';

@Injectable()
export class PricingService {
  /**
   * Calcula el precio final de la reserva multiplicando el precio base por hora
   * por los multiplicadores de la pista según sea Horario Punta (Peak) o Valle (OffPeak).
   * Horas Punta configuradas por defecto: Lunes a Viernes de 18:00 a 22:00. Y Fines de Semana completos.
   */
  calculateDynamicPrice(
    startTime: Date, 
    basePrice: number, 
    peakMultiplier: number, 
    offPeakMultiplier: number
  ): number {
    const day = getDay(startTime); // 0 = Sunday, 1 = Monday ... 6 = Saturday
    const startHour = getHours(startTime);

    const isWeekend = day === 0 || day === 6;
    const isPeakHourWeekDay = !isWeekend && (startHour >= 18 && startHour < 22);

    if (isWeekend || isPeakHourWeekDay) {
      // Es una hora Punta
      return Math.round(basePrice * peakMultiplier);
    } else {
      // Hora Valle
      return Math.round(basePrice * offPeakMultiplier);
    }
  }
}
