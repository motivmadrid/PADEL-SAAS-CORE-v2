import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    @InjectQueue('notifications') private notificationsQueue: Queue,
  ) {}

  async validateUser(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) throw new UnauthorizedException('Credenciales inválidas');

    const passwordValid = await bcrypt.compare(password, user.password);
    if (!passwordValid) throw new UnauthorizedException('Credenciales inválidas');

    return user;
  }

  /**
   * Genera tanto el Access Token (15m) como el Refresh Token (7d)
   */
  async generateTokens(userId: string, email: string, role: string) {
    const payload = { sub: userId, email, role };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_ACCESS_SECRET || 'super-secret-access-key',
        expiresIn: '15m',
      }),
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-key',
        expiresIn: '7d', // Larga duración para cookie
      }),
    ]);

    return {
      accessToken,
      refreshToken,
    };
  }

  /**
   * Validar un refresh token y devolver nuevos tokens si es válido
   */
  async refreshTokens(refreshToken: string) {
    try {
      const payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET || 'super-secret-refresh-key',
      });
      
      // Asegurar que el usuario todavía existe y no ha sido baneado/eliminado
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) throw new UnauthorizedException('Usuario no existe');

      // Generar nuevo par de tokens
      return this.generateTokens(user.id, user.email, user.role);
    } catch (e) {
      throw new UnauthorizedException('Refresh token no es válido o ha expirado.');
    }
  }

  /**
   * Petición de reseteo de contraseña
   */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return { message: 'Si el correo existe, se enviará el enlace.' }; // Prevención User-Enumeration
    
    // Generación token de alta entropía y hashing seguro
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora de validez

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: hashedToken,
        resetTokenExpires: expiresAt,
      }
    });

    // Enviar Job a BullMQ para simulación de correo
    await this.notificationsQueue.add('send-reset-password', {
      email: user.email,
      token: resetToken,
    });

    return { message: 'Si el correo existe, se enviará el enlace.' };
  }

  /**
   * Confirmación y reseteo real de contraseña
   */
  async resetPassword(token: string, newPassword: string) {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    
    const user = await this.prisma.user.findFirst({
      where: {
        resetToken: hashedToken,
        resetTokenExpires: { gt: new Date() },
      }
    });

    if (!user) {
      throw new BadRequestException('Token inválido o expirado');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpires: null,
      }
    });

    return { message: 'Contraseña actualizada correctamente.' };
  }
}
