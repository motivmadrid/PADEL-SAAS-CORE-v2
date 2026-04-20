import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisLockService implements OnModuleInit, OnModuleDestroy {
  private redisClient: Redis;
  private readonly logger = new Logger(RedisLockService.name);

  // El TTL mandatorio solicitado: 10 minutos (en milisegundos)
  private readonly LOCK_TTL_MS = 10 * 60 * 1000;

  onModuleInit() {
    this.redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10) || 6379,
    });
    this.logger.log('RedisLockService conectado a Redis');
  }

  onModuleDestroy() {
    this.redisClient.quit();
  }

  /**
   * Intenta bloquear una pista para un tramo horario específico protegido por el ID del usuario (sesión UUID).
   * @param courtId ID de la pista
   * @param timeSlot String que represente la franja de tiempo (Ej. '2026-10-15T18:00Z_2026-10-15T19:30Z')
   * @param userId El UUID del usuario que adquiere el bloqueo
   * @returns true si adquiere el bloqueo, false si ya está bloqueado por otro.
   */
  async acquireLock(courtId: string, timeSlot: string, userId: string): Promise<boolean> {
    const lockKey = `lock:court:${courtId}:slot:${timeSlot}`;

    // SETNX atómico usando ioredis 'set' con opciones:
    // NX: Set if Not eXists
    // PX: Time To Live in milliseconds (10 mins absoluto)
    const result = await this.redisClient.set(lockKey, userId, 'PX', this.LOCK_TTL_MS, 'NX');
    
    if (result === 'OK') {
      this.logger.debug(`Lock ADQUIRIDO por userId: ${userId} en pista ${courtId} (Slot: ${timeSlot}) | TTL: 10 mins`);
      return true;
    }
    
    this.logger.debug(`Lock DENEGADO por colisión en pista ${courtId} (Slot: ${timeSlot})`);
    return false;
  }

  /**
   * Libera un bloqueo de pista ÚNICAMENTE si el UUID guardado coindice con el `userId`
   * que solicita liberarlo. De esta forma, evitamos que un usuario B borre el lock del usuario A.
   * Utiliza un Lua Script para garantizar la atomicidad (Leer + Comparar + Borrar en un paso).
   */
  async releaseLock(courtId: string, timeSlot: string, userId: string): Promise<boolean> {
    const lockKey = `lock:court:${courtId}:slot:${timeSlot}`;

    // LUA Script:
    // 1. Obtiene el valor (KEYS[1])
    // 2. Si coincide con el parámetro esperado (ARGV[1]) lo elimina y devuelve 1
    // 3. Si no, devuelve 0
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    // Ejecución atómica
    // arguments: script, numKeys, key1, arg1
    const result = await this.redisClient.eval(luaScript, 1, lockKey, userId);

    if (result === 1) {
      this.logger.debug(`Lock LIBERADO exitosamente por userId: ${userId} para pista ${courtId}`);
      return true;
    }

    this.logger.warn(`Intento FALLIDO de liberación de lock para pista ${courtId} (Slot: ${timeSlot}). UserId no coincide o Lock ya expirado.`);
    return false;
  }

  /**
   * Obtiene todos los slots bloqueados activamente en Redis para una pista.
   * Usa scanStream (iteración no bloqueante) en lugar de KEYS para no bloquear Redis en producción.
   */
  async getActiveLocks(courtId: string): Promise<string[]> {
    const pattern = `lock:court:${courtId}:slot:*`;
    const keys: string[] = [];

    return new Promise((resolve, reject) => {
      const stream = this.redisClient.scanStream({ match: pattern, count: 100 });
      stream.on('data', (resultKeys: string[]) => keys.push(...resultKeys));
      stream.on('end', () =>
        resolve(keys.map(key => key.split(':slot:')[1]))
      );
      stream.on('error', reject);
    });
  }
}
