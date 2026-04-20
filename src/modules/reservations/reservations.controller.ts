import { Controller, Get, Param, Query, Post, Body, UseGuards, Request } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';

@Controller('reservations') // Changed to /reservations instead of /courts to match the new endpoints logically and support previous roots by creating standard paths
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get(':id/availability')
  async getAvailability(@Param('id') id: string, @Query('date') date: string) {
    if (!date) {
      date = new Date().toISOString().split('T')[0]; // Default to today
    }
    return this.reservationsService.getAvailability(id, date);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/reserve')
  async reserve(@Param('id') courtId: string, @Body() dto: CreateReservationDto, @Request() req) {
    // Inject courtId from route param
    dto.courtId = courtId;
    return this.reservationsService.initiateReservation(req.user.id, dto);
  }

  // == PHASE 6: Admin Endpoints ==
  
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Post('cancel-weather')
  async cancelWeather(@Body('date') date: string, @Body('courtType') courtType: string) {
    return this.reservationsService.cancelWeather(date, courtType);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Post('recurring')
  async recurring(@Body() body: { courtId: string, baseStartDate: string, endDate: string, durationMinutes: number }, @Request() req) {
    return this.reservationsService.createRecurringReservations(req.user.id, body);
  }
}
