import { IsNotEmpty, IsUUID, IsDateString, IsBoolean, IsOptional, IsInt, Min } from 'class-validator';

export class CreateReservationDto {
  @IsUUID()
  @IsNotEmpty()
  courtId: string;

  @IsDateString()
  @IsNotEmpty()
  startTime: string; // ISO 8601 string for UTC validation

  @IsDateString()
  @IsNotEmpty()
  endTime: string;

  @IsBoolean()
  @IsOptional()
  isPublic?: boolean;

  // The split payments part or total price might be calculated by backend, 
  // but if the frontend sends the expected price for validation we can include it:
  @IsInt()
  @Min(0)
  @IsOptional()
  expectedPrice?: number;
}
