import pino from 'pino';
import type { SquireConfig } from './config.js';

export function createLogger(config: SquireConfig) {
  return pino({
    level: config.logging.level,
    transport: config.logging.format === 'pretty' ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    } : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;
