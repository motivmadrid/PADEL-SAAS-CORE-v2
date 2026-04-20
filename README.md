# Padel SaaS — Backend API

Sistema de reservas de pistas de pádel con pagos integrados, pricing dinámico y arquitectura orientada a producción. Construido con NestJS, PostgreSQL, Redis y Stripe.

---

## Índice

1. [Descripción del producto](#1-descripción-del-producto)
2. [Arquitectura técnica](#2-arquitectura-técnica)
3. [Diagrama de módulos](#3-diagrama-de-módulos)
4. [Modelo de datos](#4-modelo-de-datos)
5. [Requisitos previos](#5-requisitos-previos)
6. [Instalación local](#6-instalación-local)
7. [Configuración del entorno](#7-configuración-del-entorno)
8. [Ejecución en producción con Docker](#8-ejecución-en-producción-con-docker)
9. [Referencia de la API](#9-referencia-de-la-api)
10. [Sistema de Redis Locks](#10-sistema-de-redis-locks)
11. [Motor de precios dinámicos](#11-motor-de-precios-dinámicos)
12. [Tests](#12-tests)

---

## 1. Descripción del producto

Padel SaaS es una plataforma de gestión y reserva de pistas de pádel. El backend expone una API REST que cubre el ciclo completo de vida de una reserva:

- **Disponibilidad en tiempo real** combinando el estado de la base de datos con los bloqueos activos en Redis.
- **Reserva con bloqueo temporal** de 10 minutos mientras el usuario completa el pago, garantizando que dos usuarios no puedan reservar la misma pista y franja al mismo tiempo.
- **Split payments**: varios jugadores pueden pagar su parte de la misma reserva de forma independiente.
- **Monedero virtual** con historial de transacciones tipo ledger para recargas, consumos y devoluciones.
- **Pagos con Stripe** con verificación criptográfica de firma en el webhook.
- **Pricing dinámico** con multiplicadores por horario punta/valle configurables por pista.
- **Reservas recurrentes** con agrupación por `recurringGroupId`.
- **Cancelación masiva** por causas meteorológicas con devolución automática al monedero.
- **Notificaciones automáticas** mediante jobs BullMQ que envían recordatorios 2 horas antes del partido.
- **Generación de recibos en PDF** en memoria sin escritura en disco.
- **Limpieza automática** de reservas `PENDING` expiradas cada 5 minutos.

### Modelo de negocio

El sistema está diseñado para clubs de pádel que gestionan múltiples pistas. Cada pista puede configurar:

| Parámetro | Descripción |
|---|---|
| `pricePerHour` | Tarifa base en céntimos de euro |
| `peakPriceMultiplier` | Multiplicador para horario punta (ej. `1.5` = +50 %) |
| `offPeakPriceMultiplier` | Multiplicador para horario valle (ej. `0.8` = −20 %) |

Los precios se almacenan y procesan siempre en **céntimos** para evitar errores de precisión de coma flotante.

---

## 2. Arquitectura técnica

```
                    ┌─────────────────────────────────────┐
                    │           Cliente HTTP               │
                    │   (App móvil / Web / Stripe CLI)     │
                    └──────────────┬──────────────────────┘
                                   │ HTTPS
                    ┌──────────────▼──────────────────────┐
                    │         NestJS API Server            │
                    │         node:22-alpine               │
                    │                                      │
                    │  ┌──────────┐  ┌──────────────────┐ │
                    │  │Throttler │  │   Pino Logger     │ │
                    │  │(Rate Lim)│  │  (JSON / Pretty)  │ │
                    │  └──────────┘  └──────────────────┘ │
                    │                                      │
                    │  ┌──────────────────────────────┐   │
                    │  │      Módulos de negocio       │   │
                    │  │  Auth · Reservations          │   │
                    │  │  Payments · Users · Scheduler │   │
                    │  └──────────────┬───────────────┘   │
                    │                 │                    │
                    │  ┌──────────────▼───────────────┐   │
                    │  │         Core Services         │   │
                    │  │  PricingService               │   │
                    │  │  RedisLockService             │   │
                    │  └──┬───────────────────────┬───┘   │
                    └─────┼───────────────────────┼───────┘
                          │                       │
           ┌──────────────▼──────┐   ┌────────────▼────────────┐
           │   PostgreSQL 16     │   │       Redis 7            │
           │                     │   │                          │
           │  Prisma ORM         │   │  Locks distribuidos      │
           │  Migraciones        │   │  BullMQ (colas)          │
           │  Exclusion          │   │  Rate limiter            │
           │  constraint         │   │  (ThrottlerStorage)      │
           └─────────────────────┘   └──────────────────────────┘
                                                │
                               ┌────────────────▼─────────────┐
                               │         BullMQ Workers        │
                               │  NotificationsProcessor       │
                               │  (email recordatorio 2 h)    │
                               └──────────────────────────────┘
```

### Stack tecnológico

| Capa | Tecnología | Versión | Rol |
|---|---|---|---|
| Framework | NestJS | 11 | Servidor HTTP, DI, módulos |
| Lenguaje | TypeScript | 5.9 | Tipado estático |
| Base de datos | PostgreSQL | 16 | Persistencia principal |
| ORM | Prisma | 6.4 | Acceso a datos, migraciones |
| Cache / Locks | Redis | 7 | Locks distribuidos, colas, rate limiting |
| Cola de tareas | BullMQ | 5 | Jobs asíncronos (recordatorios email) |
| Pagos | Stripe SDK | 22 | Cobros, webhooks firmados |
| Autenticación | JWT + Passport | — | Access + Refresh tokens en cookies |
| Validación | class-validator | 0.15 | Validación de DTOs |
| PDF | PDFKit | 0.18 | Recibos en memoria |
| Observabilidad | Pino + Sentry | — | Logs JSON estructurados, APM |
| Scheduler | @nestjs/schedule | 6 | Cron jobs internos |
| Runtime Docker | node:22-alpine + dumb-init | — | Imagen de producción mínima |

---

## 3. Diagrama de módulos

```
src/
│
├── main.ts                          ← Bootstrap, raw body, Swagger, Sentry
├── app.module.ts                    ← Raíz: ThrottlerModule, BullModule, LoggerModule
│
├── prisma/
│   ├── prisma.module.ts             ← Exporta PrismaService a todos los módulos
│   └── prisma.service.ts            ← Extiende PrismaClient con lifecycle hooks
│
├── core/                            ← Servicios transversales sin lógica de negocio
│   ├── guards/
│   │   ├── jwt-auth.guard.ts        ← Protege rutas con JWT Bearer
│   │   └── roles.guard.ts           ← Control de acceso por rol (USER / ADMIN)
│   ├── decorators/
│   │   └── roles.decorator.ts       ← @Roles('ADMIN')
│   ├── pricing/
│   │   ├── pricing.module.ts
│   │   └── pricing.service.ts       ← Motor de precios punta/valle
│   └── redis/
│       └── redis-lock.service.ts    ← SET NX PX + Lua script release + scanStream
│
└── modules/
    ├── auth/
    │   ├── auth.module.ts
    │   ├── auth.controller.ts       ← /auth/*
    │   ├── auth.service.ts          ← Login, refresh, logout, recuperación contraseña
    │   └── jwt.strategy.ts          ← Valida JWT del header Authorization
    │
    ├── users/
    │   ├── users.module.ts
    │   ├── users.controller.ts      ← /users (extensible)
    │   └── users.service.ts
    │
    ├── reservations/
    │   ├── reservations.module.ts
    │   ├── reservations.controller.ts  ← /reservations/*
    │   ├── reservations.service.ts     ← Reserva, disponibilidad, recurrentes, lluvia
    │   └── dto/
    │       └── create-reservation.dto.ts
    │
    ├── payments/
    │   ├── payments.module.ts           ← Registra provider STRIPE_CLIENT
    │   ├── payments.controller.ts       ← /payments/*
    │   ├── payments.service.ts          ← Webhook, wallet, PDF, finalización split
    │   └── notifications.processor.ts  ← Worker BullMQ: email recordatorio
    │
    └── scheduler/
        ├── scheduler.module.ts
        └── scheduler.service.ts         ← Cron */5 min: limpia PENDING expirados
```

---

## 4. Modelo de datos

```
┌──────────────┐         ┌────────────────────┐
│     User     │────────▶│    Reservation     │
│──────────────│  1:N    │────────────────────│
│ id (UUID)    │         │ id (UUID)          │
│ email        │         │ courtId ──────────┐│
│ password     │         │ userId            ││
│ role         │         │ startTime (UTC)   ││
│ walletBalance│         │ endTime   (UTC)   ││
│ resetToken   │         │ status            ││
└──────┬───────┘         │ totalPrice (cts)  ││
       │                 │ recurringGroupId  ││
       │ 1:N             └────────┬──────────┘│
       │                         │ 1:N       │
       │              ┌──────────▼──────────┐ │
       │              │ ReservationPayment  │ │
       │              │─────────────────────│ │
       └─────────────▶│ id (UUID)           │ │
           1:N        │ reservationId       │ │
                      │ userId              │ │
                      │ amount (cts)        │ │
                      │ status              │ │
                      │ paymentMethod       │ │
                      │ providerId @unique  │ │
                      └─────────────────────┘ │
                                              │
       ┌──────────────────────────────────────┘
       │
       ▼
┌──────────────┐         ┌───────────────────┐
│    Court     │────────▶│     Waitlist      │
│──────────────│  1:N    │───────────────────│
│ id (UUID)    │         │ userId            │
│ name         │         │ courtId           │
│ type (enum)  │         │ startTime         │
│ pricePerHour │         │ endTime           │
│ peakMult     │         │ @@unique(userId,  │
│ offPeakMult  │         │  courtId,start,   │
└──────────────┘         │  end)             │
                         └───────────────────┘

┌────────────────────┐
│  WalletTransaction │   ← Ledger inmutable (onDelete: Restrict)
│────────────────────│
│ id (UUID)          │
│ userId             │
│ amount (cts)       │   positivo = DEPOSIT / REFUND
│ type (enum)        │   negativo = WITHDRAW
│ referenceId        │
└────────────────────┘
```

**Enums del schema:**

| Enum | Valores |
|---|---|
| `Role` | `USER`, `ADMIN` |
| `ReservationStatus` | `PENDING`, `PAID`, `CANCELLED` |
| `PaymentStatus` | `PENDING`, `COMPLETED`, `FAILED`, `REFUNDED` |
| `PaymentMethod` | `WALLET`, `CREDIT_CARD`, `BANK_TRANSFER` |
| `CourtType` | `INDOOR`, `OUTDOOR`, `COVERED` |
| `TransactionType` | `DEPOSIT`, `WITHDRAW`, `REFUND` |

**Índices de producción aplicados:**

| Tabla | Índice | Propósito |
|---|---|---|
| `Reservation` | `(courtId, startTime, endTime)` | Consulta de disponibilidad |
| `Reservation` | `(userId, status)` | Reservas activas de un usuario |
| `Reservation` | `(status)` | Job de limpieza de expirados |
| `ReservationPayment` | `(reservationId)` | Carga de pagos de una reserva |
| `ReservationPayment` | `providerId` UNIQUE | Idempotencia de webhooks Stripe |
| `WalletTransaction` | `(userId, createdAt)` | Historial paginado por fecha |
| `Waitlist` | `(userId, courtId, startTime, endTime)` UNIQUE | Sin duplicados en lista de espera |

---

## 5. Requisitos previos

| Herramienta | Versión mínima | Comprobación |
|---|---|---|
| Node.js | 22 LTS | `node --version` |
| npm | 10 | `npm --version` |
| PostgreSQL | 16 | `psql --version` |
| Redis | 7 | `redis-server --version` |
| Docker + Compose | Docker 25 / Compose V2 | `docker compose version` |

**Instalación local en macOS (Homebrew):**

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

---

## 6. Instalación local

### 6.1 Clonar el repositorio e instalar dependencias

```bash
git clone <url-del-repositorio>
cd padel-saas-core

npm install
```

### 6.2 Configurar el entorno

```bash
# Copiar la plantilla
cp .env.example .env

# Generar secretos seguros
bash scripts/generate-secrets.sh
```

Copiar los valores generados al `.env` (ver sección [7](#7-configuración-del-entorno)).

### 6.3 Crear la base de datos y ejecutar migraciones

```bash
# Crear la base de datos local
createdb padel_db

# Aplicar todas las migraciones Prisma
npx prisma migrate dev

# Aplicar el exclusion constraint de no solapamiento (migración SQL manual)
psql $DATABASE_URL -f prisma/migrations/manual_exclusion_constraint.sql
```

### 6.4 Generar el Prisma Client

```bash
npx prisma generate
```

### 6.5 (Opcional) Cargar datos de prueba

```bash
npx prisma db seed
```

Crea los usuarios `admin@padel.com`, `user1@padel.com`, `user2@padel.com` y cuatro pistas de ejemplo.

### 6.6 Arrancar el servidor

```bash
# Desarrollo con hot reload
npm run start:dev

# Modo debug
npm run start:debug
```

| URL | Descripción |
|---|---|
| `http://localhost:3000` | API REST |
| `http://localhost:3000/api/docs` | Swagger UI |
| `http://localhost:3000/api/queues` | Bull Board (monitor de colas) |

---

## 7. Configuración del entorno

El archivo `.env` contiene todos los secretos y parámetros de configuración. **Nunca lo incluyas en el repositorio.**

### Generar secretos

```bash
bash scripts/generate-secrets.sh
```

Salida de ejemplo:

```
✔ Secretos generados correctamente

POSTGRES_PASSWORD="6cd6fb0a8acc33f917c1d8bbdd2dce53"

JWT_ACCESS_SECRET="57bbed87a503d8e10f746ab6819067feb9eac9..."
JWT_REFRESH_SECRET="d75d07d179d4864dbce4b80e43a85e4a017a0e5..."

STRIPE_WEBHOOK_SECRET="whsec_8bf5d028254130f1c1339aafaace4684bf04..."
```

Cada ejecución produce valores distintos. Guárdalos en un gestor de secretos antes de cerrar la terminal.

### Referencia de variables

| Variable | Ejemplo | Obligatoria | Descripción |
|---|---|---|---|
| `PORT` | `3000` | — | Puerto del servidor NestJS |
| `NODE_ENV` | `development` | — | `development` \| `production` \| `test` |
| `POSTGRES_USER` | `padel` | Docker | Usuario de PostgreSQL |
| `POSTGRES_PASSWORD` | _(generado)_ | **Sí (Docker)** | Contraseña de PostgreSQL |
| `POSTGRES_DB` | `padel_db` | Docker | Nombre de la base de datos |
| `DATABASE_URL` | `postgresql://padel:...@localhost:5432/padel_db?schema=public` | **Sí** | Connection string de Prisma |
| `JWT_ACCESS_SECRET` | _(64 hex)_ | **Sí** | Firma de Access Tokens (~15 min) |
| `JWT_REFRESH_SECRET` | _(64 hex)_ | **Sí** | Firma de Refresh Tokens (~7 días) — distinto al anterior |
| `STRIPE_SECRET_KEY` | `sk_test_...` | **Sí** | Clave secreta de Stripe (`sk_live_` en prod) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | **Sí** | Secreto de firma del webhook de Stripe |
| `REDIS_HOST` | `localhost` | — | Host de Redis (en Docker: nombre del servicio `redis`) |
| `REDIS_PORT` | `6379` | — | Puerto de Redis |
| `FRONTEND_URL` | `http://localhost:3000` | — | Origen permitido por CORS |
| `SENTRY_DSN` | `https://...@sentry.io/...` | — | DSN de Sentry (vacío = deshabilitado) |

> **Nota sobre `DATABASE_URL` en Docker:** el `docker-compose.yml` sobreescribe esta variable automáticamente para usar el nombre de servicio `postgres` en lugar de `localhost`. El valor en `.env` solo se usa en desarrollo local.

---

## 8. Ejecución en producción con Docker

### 8.1 Preparar el `.env`

```bash
cp .env.example .env
bash scripts/generate-secrets.sh   # copiar los valores al .env

# Completar manualmente en .env:
# STRIPE_SECRET_KEY=sk_live_...
# STRIPE_WEBHOOK_SECRET=whsec_...  (desde Stripe Dashboard → Webhooks)
# SENTRY_DSN=https://...           (desde tu proyecto en sentry.io)
```

### 8.2 Levantar el stack completo

```bash
# Primera vez, o tras cambios en el código
docker compose up -d --build

# Sin reconstruir (reinicio rápido)
docker compose up -d
```

Docker Compose arranca los servicios en orden de dependencias con healthchecks:

```
postgres ──(healthy)──▶ redis ──(healthy)──▶ app
```

Al arrancar, el contenedor `app` ejecuta automáticamente:

```
node_modules/.bin/prisma migrate deploy && node dist/main
```

`prisma migrate deploy` es idempotente: solo aplica las migraciones pendientes.

### 8.3 Comandos de operación

```bash
# Logs en tiempo real
docker compose logs -f app

# Estado de los tres servicios y sus healthchecks
docker compose ps

# Acceder a la base de datos
docker compose exec postgres psql -U padel -d padel_db

# Acceder al CLI de Redis
docker compose exec redis redis-cli

# Aplicar el exclusion constraint (primera vez o tras resetear la BD)
docker compose exec app \
  node_modules/.bin/prisma db execute \
  --file prisma/migrations/manual_exclusion_constraint.sql \
  --schema prisma/schema.prisma

# Parar el stack (conserva volúmenes y datos)
docker compose down

# Parar y destruir todos los datos  ⚠ irreversible
docker compose down -v
```

### 8.4 Arquitectura de la imagen Docker

La imagen se construye en tres stages para maximizar caché y minimizar tamaño final:

```
┌─────────────────────────────────────────────────────────────┐
│ Stage deps                                                  │
│   npm ci --omit=dev                                         │
│   npm install --no-save prisma   ← CLI para migrate deploy  │
├─────────────────────────────────────────────────────────────┤
│ Stage builder                                               │
│   npm ci  (todas las deps)                                  │
│   npx prisma generate            ← genera .prisma/client   │
│   npm run build                  ← compila TypeScript       │
├─────────────────────────────────────────────────────────────┤
│ Stage production  (imagen final)                            │
│   FROM node:22-alpine                                       │
│   apk add openssl dumb-init                                 │
│   COPY node_modules  ←── de deps                           │
│   COPY .prisma/      ←── de builder  (client generado)     │
│   COPY dist/         ←── de builder  (JS compilado)        │
│   COPY prisma/       ←── schema para migrate deploy        │
│   USER node          ←── usuario no-root (UID 1000)        │
│   ENTRYPOINT dumb-init                                      │
│   CMD prisma migrate deploy && node dist/main               │
└─────────────────────────────────────────────────────────────┘
```

La imagen final no contiene código fuente TypeScript, devDependencies ni herramientas de compilación.

---

## 9. Referencia de la API

La documentación interactiva completa está disponible en Swagger UI en `http://localhost:3000/api/docs`.

### 9.1 Autenticación — `/auth`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `POST` | `/auth/login` | — | Autentica con `email` y `password`. Devuelve Access Token en el body y Refresh Token en cookie `httpOnly`. |
| `POST` | `/auth/refresh` | Cookie | Rota el Refresh Token y emite un nuevo Access Token. |
| `POST` | `/auth/logout` | Cookie | Invalida el Refresh Token y borra la cookie. |
| `POST` | `/auth/forgot-password` | — | Inicia recuperación de contraseña. Recibe `{ email }`. |
| `POST` | `/auth/reset-password` | — | Finaliza recuperación. Recibe `{ token, newPassword }`. |

Todas las rutas protegidas requieren:
```
Authorization: Bearer <access_token>
```

**Ejemplo de login:**
```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user1@padel.com", "password": "mi-contraseña"}'
```

---

### 9.2 Reservas — `/reservations`

| Método | Ruta | Auth | Rol | Descripción |
|---|---|---|---|---|
| `GET` | `/reservations/:courtId/availability` | — | — | Disponibilidad de una pista para un día (`?date=YYYY-MM-DD`). Combina reservas en BD con locks activos en Redis. |
| `POST` | `/reservations/:courtId/reserve` | JWT | USER | Inicia una reserva: adquiere lock Redis (10 min), calcula precio dinámico, crea `Reservation` + `ReservationPayment` en `PENDING`. |
| `POST` | `/reservations/cancel-weather` | JWT | ADMIN | Cancela todas las reservas de un tramo por causas meteorológicas y acredita el importe en el monedero de cada jugador. |
| `POST` | `/reservations/recurring` | JWT | ADMIN | Crea una serie de reservas recurrentes (diaria o semanal). Todas comparten el mismo `recurringGroupId`. |

**Body de reserva:**
```json
{
  "courtId": "uuid-de-la-pista",
  "startTime": "2026-06-15T18:00:00.000Z",
  "endTime": "2026-06-15T19:30:00.000Z",
  "isPublic": false
}
```

**Respuesta de reserva exitosa:**
```json
{
  "message": "Pista bloqueada temporalmente. Tienes 10 minutos para completar el pago.",
  "reservationId": "uuid",
  "paymentId": "uuid",
  "amountToPay": 3000
}
```

---

### 9.3 Pagos — `/payments`

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `POST` | `/payments/webhook/stripe` | Firma Stripe | Webhook de Stripe. Verifica la firma con `stripe.webhooks.constructEvent` usando el raw body. Procesa `payment_intent.succeeded` y finaliza la reserva si todos los split payments están completados. |
| `POST` | `/payments/:paymentId/wallet` | JWT | Paga un tramo de reserva con saldo del monedero virtual. Descuenta saldo, registra `WalletTransaction` y finaliza la reserva si el total pagado cubre el precio. |
| `GET` | `/payments/:paymentId/receipt` | — | Genera y devuelve un recibo en PDF (`Content-Type: application/pdf`) en memoria. |

**Configurar el webhook de Stripe en desarrollo:**
```bash
# Reenvía eventos de Stripe a tu servidor local
stripe listen --forward-to localhost:3000/payments/webhook/stripe

# El CLI imprime el STRIPE_WEBHOOK_SECRET — añadirlo al .env
```

---

### 9.4 Infraestructura

| Ruta | Descripción |
|---|---|
| `GET /` | Health check básico |
| `GET /api/docs` | Swagger UI |
| `GET /api/queues` | Bull Board — monitor visual de colas BullMQ |

---

## 10. Sistema de Redis Locks

El sistema de reservas usa **locks distribuidos en Redis** como primera línea de defensa contra condiciones de carrera cuando varios usuarios intentan reservar la misma pista y franja horaria de forma simultánea.

### Flujo de adquisición y liberación

```
Usuario A                    Redis                    Usuario B
    │                          │                          │
    │─── acquireLock ─────────▶│                          │
    │    SET NX PX 600000      │                          │
    │◀── "OK" (adquirido) ─────│                          │
    │                          │                          │
    │    [completa el pago]    │    ── acquireLock ───────▶│
    │                          │    SET NX PX 600000       │
    │                          │◀── NULL (colisión) ───────│
    │                          │    BadRequestException    │
    │─── releaseLock ──────────▶│                          │
    │    [Lua script atómico]   │                          │
    │◀── 1 (liberado) ──────── │                          │
```

### Clave de lock en Redis

```
lock:court:{courtId}:slot:{startTimeISO}_{endTimeISO}
```

Ejemplo:
```
lock:court:a3f2c1d0:slot:2026-06-15T18:00:00.000Z_2026-06-15T19:30:00.000Z
```

### Garantías del sistema

| Propiedad | Mecanismo |
|---|---|
| **Adquisición atómica** | `SET key value NX PX ttl` — una sola operación Redis, sin race condition |
| **TTL de 10 minutos** | `PX 600000` — el lock expira automáticamente aunque el proceso muera |
| **Liberación segura** | Script Lua: `GET` + `comparar` + `DEL` en un único paso atómico. Impide que el usuario B libere el lock del usuario A |
| **Consulta no bloqueante** | `scanStream({ match, count: 100 })` en lugar de `KEYS *`, para no bloquear Redis en producción al listar locks activos |

### Segunda línea de defensa: constraint en PostgreSQL

El lock Redis puede expirar si el proceso tarda demasiado o si Redis reinicia. La base de datos tiene un **exclusion constraint** con `btree_gist` que impide físicamente dos reservas activas solapadas:

```sql
ALTER TABLE "Reservation"
  ADD CONSTRAINT no_overlapping_reservations
  EXCLUDE USING gist (
    "courtId" WITH =,
    tsrange("startTime", "endTime", '[)') WITH &&
  )
  WHERE (status <> 'CANCELLED'::"ReservationStatus");
```

El intervalo `[)` (cerrado-abierto) permite reservas consecutivas sin conflicto: un partido de 10:00 a 11:00 no colisiona con uno de 11:00 a 12:00.

### Limpieza automática de reservas expiradas

El `SchedulerService` ejecuta cada 5 minutos un cron job que cancela reservas `PENDING` cuyo `createdAt` supera los 10 minutos (el TTL del lock):

```
Cada 5 minutos:
  1. SELECT id WHERE status = PENDING AND createdAt < now() - 10 min
  2. UPDATE ReservationPayment SET status = FAILED WHERE reservationId IN (ids)
  3. UPDATE Reservation SET status = CANCELLED WHERE id IN (ids)
  4. Logger: "Cleanup: N reserva(s) expirada(s) canceladas, M pago(s) liberados"
```

Todo dentro de una única transacción Prisma (`$transaction`) para garantizar atomicidad.

---

## 11. Motor de precios dinámicos

El `PricingService` calcula el precio final en el momento de crear la reserva. El precio queda **fijado en ese instante** y no varía aunque los multiplicadores de la pista se modifiquen después.

### Lógica de clasificación horaria

```
¿Es fin de semana? (sábado o domingo)
     │
     ├── SÍ → HORARIO PUNTA
     │         precio = basePrice × peakPriceMultiplier
     │
     └── NO → ¿Es día laborable entre las 18:00 y las 21:59?
                   │
                   ├── SÍ → HORARIO PUNTA
                   │         precio = basePrice × peakPriceMultiplier
                   │
                   └── NO → HORARIO VALLE
                             precio = basePrice × offPeakPriceMultiplier
```

### Ejemplo de cálculo

Pista con `pricePerHour = 2000` cts (20 €), `peakPriceMultiplier = 1.5`, `offPeakPriceMultiplier = 0.8`:

| Franja horaria | Día | Multiplicador | Precio final |
|---|---|---|---|
| 10:00 – 11:30 | Martes | 0.8 (valle) | 1.600 cts = **16 €** |
| 19:00 – 20:30 | Jueves | 1.5 (punta) | 3.000 cts = **30 €** |
| 11:00 – 12:30 | Sábado | 1.5 (punta) | 3.000 cts = **30 €** |

Los precios se redondean al céntimo con `Math.round()`.

### Configurar multiplicadores

Los multiplicadores se almacenan en la tabla `Court` de la base de datos y pueden actualizarse por pista sin necesidad de despliegues. Un endpoint de administración (`PATCH /courts/:id`) puede exponerlos en futuras fases.

---

## 12. Tests

### Ejecutar los tests

```bash
# Tests unitarios
npm test

# Modo watch (re-ejecuta al guardar)
npm run test:watch

# Con informe de cobertura
npm run test:cov
```

### Suite actual

```
src/modules/payments/payments.service.spec.ts   13 tests  ✓
```

Los tests unitarios mockean completamente `PrismaService`, la cola BullMQ y el cliente Stripe. **No requieren ninguna conexión externa** para ejecutarse.

#### `handleStripeWebhook` — 7 tests

| Test | Qué verifica |
|---|---|
| Firma inválida | `constructEvent` lanza → el servicio relanza `BadRequestException` con el mensaje de Stripe |
| Mensaje propagado | El texto de error original de Stripe aparece en la excepción |
| Tipo de evento distinto | No llama a `$transaction` si el evento no es `payment_intent.succeeded` |
| `paymentId` ausente en metadata | Lanza **antes** de entrar en la transacción (verificado con `not.toHaveBeenCalled`) |
| Pago no encontrado | `findUnique` devuelve `null` → `BadRequestException('Pago no encontrado')` |
| Idempotencia | Pago ya `COMPLETED` → no llama a `update` |
| Happy path | Marca `COMPLETED` y delega en `checkAndFinalizeReservation` con los argumentos correctos |

#### `checkAndFinalizeReservation` — 6 tests (método privado vía `(service as any)`)

| Test | Qué verifica |
|---|---|
| `totalPaid < totalPrice` | No actualiza la reserva ni encola ningún job |
| Pagos no-`COMPLETED` no cuentan | Solo suma los pagos con status `COMPLETED` |
| `totalPaid >= totalPrice` | Actualiza la reserva a `PAID` |
| Partido > 2 h en el futuro | Encola `send-reminder` con `delay > 0` |
| Partido < 2 h en el futuro | Marca `PAID` pero **no** encola el job de recordatorio |
| Split payment exacto | Varios pagos que suman exactamente `totalPrice` activan la finalización |

### Configuración de Jest

```json
{
  "rootDir": "src",
  "testRegex": ".*\\.spec\\.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" },
  "testEnvironment": "node"
}
```

---

## Licencia

Privado — todos los derechos reservados.
