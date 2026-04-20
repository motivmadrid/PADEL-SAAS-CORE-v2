import { Controller, Get, Param, Query, Post, Body, UseGuards, Request } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('courts')
export class CourtsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getCourts() {
    return this.prisma.court.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }
}

@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id/availability')
  async getAvailability(@Param('id') id: string, @Query('date') date: string) {
    if (!date) {
      date = new Date().toISOString().split('T')[0];
    }
    return this.reservationsService.getAvailability(id, date);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/reserve')
  async reserve(@Param('id') courtId: string, @Body() dto: CreateReservationDto, @Request() req) {
    dto.courtId = courtId;
    return this.reservationsService.initiateReservation(req.user.id, dto);
  }

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
