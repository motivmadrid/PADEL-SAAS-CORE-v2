import { Controller, Post, Body, Res, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';

interface ExpressResponse {
  cookie(name: string, val: string, options: Record<string, unknown>): void;
  clearCookie(name: string): void;
}
interface ExpressRequest {
  cookies: Record<string, string>;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('register')
  async register(@Body() dto: CreateUserDto) {
    return this.usersService.createUser(dto);
  }

  @Post('login')
  async login(
    @Body() body: { email: string; password: string },
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const user = await this.authService.validateUser(body.email, body.password);

    const { accessToken, refreshToken } = await this.authService.generateTokens(
      user.id,
      user.email,
      user.role,
    );

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return { accessToken, message: 'Logged in successfully' };
  }

  @Post('refresh')
  async refresh(
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const rfToken = req.cookies['refresh_token'];
    if (!rfToken) throw new UnauthorizedException('Refresh token no provisto.');

    const { accessToken, refreshToken } = await this.authService.refreshTokens(rfToken);

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return { accessToken, message: 'Token refrescado' };
  }

  @Post('logout')
  async logout(@Res({ passthrough: true }) res: ExpressResponse) {
    res.clearCookie('refresh_token');
    return { message: 'Logged out successfully' };
  }

  @Post('forgot-password')
  async forgotPassword(@Body() body: { email: string }) {
    return this.authService.forgotPassword(body.email);
  }

  @Post('reset-password')
  async resetPassword(@Body() body: { token: string; newPassword: string }) {
    return this.authService.resetPassword(body.token, body.newPassword);
  }
}
