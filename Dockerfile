# ═══════════════════════════════════════════════════════════════════════════════
# Stage 1 — deps
# node_modules de producción + Prisma CLI para migrate deploy en runtime.
# Se separa del builder para maximizar la caché: si solo cambia código fuente,
# este stage no se re-ejecuta.
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

# Instalar solo dependencias de producción
RUN npm ci --omit=dev

# El CLI de Prisma está en devDependencies, pero se necesita en el contenedor
# para ejecutar `prisma migrate deploy` al arrancar.
# Alternativa permanente: mover `prisma` de devDependencies a dependencies.
RUN npm install --no-save prisma


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 2 — builder
# Instala todas las dependencias, genera el Prisma Client y compila TypeScript.
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/

# Instalar todas las dependencias (incluyendo devDependencies para compilar)
RUN npm ci

# Generar el Prisma Client ANTES de copiar el código fuente.
# Los tipos generados son importados por el código — deben existir al compilar.
#
# Nota multi-plataforma: si construyes en macOS Apple Silicon para desplegar en
# Linux x86-64, añade binaryTargets en schema.prisma:
#   binaryTargets = ["native", "linux-musl-openssl-3.0.x"]
RUN npx prisma generate

# Copiar el código fuente y compilar TypeScript
COPY . .
RUN npm run build


# ═══════════════════════════════════════════════════════════════════════════════
# Stage 3 — production
# Imagen final mínima: solo artefactos de runtime, sin código fuente ni
# herramientas de compilación.
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:22-alpine AS production

# openssl   — requerido por los binarios query-engine de Prisma en Alpine (musl)
# dumb-init — actúa como PID 1, reenvía señales SIGTERM/SIGINT al proceso Node
#             y recoge procesos zombie (imprescindible para graceful shutdown)
RUN apk add --no-cache openssl dumb-init

WORKDIR /app

# Asegurar que el directorio pertenece al usuario no-root antes de USER
RUN chown node:node /app

# ── Artefactos del stage deps ─────────────────────────────────────────────────
# node_modules de producción (incluye el CLI de Prisma para migrate deploy)
COPY --chown=node:node --from=deps    /app/node_modules         ./node_modules

# ── Artefactos del stage builder ──────────────────────────────────────────────
# El Prisma Client generado (binarios query-engine + JS runtime).
# Sobreescribe el stub vacío que @prisma/client deja en deps.
COPY --chown=node:node --from=builder /app/node_modules/.prisma  ./node_modules/.prisma

# Código compilado
COPY --chown=node:node --from=builder /app/dist                  ./dist

# ── Archivos de configuración necesarios en runtime ───────────────────────────
# Schema Prisma: requerido por `prisma migrate deploy`
COPY --chown=node:node prisma                                     ./prisma

# package.json: algunos módulos lo leen para detectar la versión de la app
COPY --chown=node:node package.json                               ./

# ── Seguridad: usuario sin privilegios ────────────────────────────────────────
# node:22-alpine incluye el usuario 'node' (UID 1000, GID 1000)
USER node

# ── Variables de entorno base ─────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# dumb-init gestiona PID 1 correctamente
ENTRYPOINT ["dumb-init", "--"]

# prisma migrate deploy es idempotente: aplica solo las migraciones pendientes.
# Se ejecuta antes de arrancar para garantizar que el esquema está sincronizado.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main"]
