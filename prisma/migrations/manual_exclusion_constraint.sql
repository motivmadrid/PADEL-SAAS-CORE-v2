-- ---------------------------------------------------------------------------
-- EXCLUSION CONSTRAINT: no_overlapping_reservations
--
-- Propósito: garantizar a nivel de base de datos que no puedan coexistir dos
-- reservas activas (PENDING o PAID) para la misma pista en un tramo solapado.
-- El Redis lock es la primera línea de defensa; esta constraint es la última.
--
-- Requisitos:
--   - Extensión btree_gist: permite usar el operador de igualdad (=) sobre
--     columnas TEXT dentro de un índice GiST, que de forma nativa solo soporta
--     operadores de rango/geometría.
--   - tsrange: tipo de rango de PostgreSQL para TIMESTAMP WITHOUT TIME ZONE,
--     que es el tipo que genera Prisma para los campos DateTime (TIMESTAMP(3)).
--
-- Semántica del intervalo '[)':
--   Cerrado por la izquierda, abierto por la derecha → [startTime, endTime)
--   Un partido de 10:00 a 11:00 NO colisiona con otro de 11:00 a 12:00.
--   Dos partidos que se solapan aunque sea un instante sí colisionan.
--
-- Cláusula WHERE:
--   Solo se aplica cuando status != 'CANCELLED'. Las reservas canceladas
--   liberan el slot y no deben bloquear nuevas reservas.
--   Las reservas PENDING sí bloquean (el lock de Redis expira, pero la reserva
--   en BD permanece PENDING hasta que un job de limpieza la cancele).
--
-- Rollback (ejecutar para deshacer):
--   ALTER TABLE "Reservation" DROP CONSTRAINT no_overlapping_reservations;
--   -- Solo eliminar la extensión si no la usa ninguna otra constraint:
--   -- DROP EXTENSION IF EXISTS btree_gist;
--
-- Ejecución:
--   psql $DATABASE_URL -f prisma/migrations/manual_exclusion_constraint.sql
-- ---------------------------------------------------------------------------

-- Paso 1: activar la extensión. IF NOT EXISTS es idempotente.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Paso 2: añadir la exclusion constraint.
ALTER TABLE "Reservation"
  ADD CONSTRAINT no_overlapping_reservations
  EXCLUDE USING gist (
    "courtId"                              WITH =,
    tsrange("startTime", "endTime", '[)')  WITH &&
  )
  WHERE (status <> 'CANCELLED'::"ReservationStatus");
