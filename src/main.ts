import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // 1. Observabilidad: Override del Logger Nativo a PINO (Rendimiento Extremo)
  app.useLogger(app.get(Logger));

  // 2. Observabilidad: Inicializar APM Sentry para excepciones no controladas
  Sentry.init({
    dsn: process.env.SENTRY_DSN || '', 
    integrations: [
      nodeProfilingIntegration(),
    ],
    tracesSampleRate: 1.0, 
    profilesSampleRate: 1.0,
  });

  // 3. CORS Estricto
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  });
  
  app.use(cookieParser());

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
  }));

  // 4. Autogeneración Swagger
  const config = new DocumentBuilder()
    .setTitle('Padel SaaS API')
    .setDescription('Documentación nativa de la API de Reservas de Pádel')
    .setVersion('1.0')
    .addBearerAuth() 
    .build();
  
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
