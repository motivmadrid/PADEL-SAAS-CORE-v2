import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      // Access Token comes in the Authorization header as a Bearer token
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_ACCESS_SECRET || 'super-secret-access-key',
    });
  }

  async validate(payload: any) {
    // This payload is the decoded JWT. It will be attached to req.user
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
