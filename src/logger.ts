import pino from 'pino';

export function createLogger(level: string, format: string) {
  return pino({
    level,
    transport: format === 'pretty' ? {
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
