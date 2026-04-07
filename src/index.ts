import express from 'express';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { executeWithEscalation } from './judge.js';
import type { ChatRequest } from './judge.js';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';

const config = loadConfig();
const logger = createLogger(config.logging.level, config.logging.format);
const metrics = createMetrics(config.server.name);

const app = express();
app.use(express.json());

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'squire' });
});

// OpenAI-compatible chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  const request = req.body as ChatRequest;
  
  logger.info({ 
    model: request.model,
    messages: request.messages.length 
  }, 'Incoming chat request');
  
  try {
    const result = await executeWithEscalation(request, config, logger, metrics);
    
    // Log validation decision (async, don't block response)
    if (config.logging.validationLog.enabled && result.finalScore !== null) {
      const logEntry = {
        timestamp: new Date().toISOString(),
        model: request.model,
        attempts: result.attempts,
        finalScore: result.finalScore,
        question: request.messages[request.messages.length - 1]?.content || '',
        response: result.response.choices[0]?.message?.content || '',
      };
      
      // Fire and forget - don't await
      (async () => {
        try {
          const logDir = config.logging.validationLog.path.split('/').slice(0, -1).join('/');
          if (logDir && !existsSync(logDir)) {
            mkdirSync(logDir, { recursive: true });
          }
          await fs.appendFile(
            config.logging.validationLog.path, 
            JSON.stringify(logEntry) + '\n'
          );
        } catch (e) {
          logger.warn({ error: e }, 'Failed to write validation log');
        }
      })();
    }
    
    res.json(result.response);
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error({ 
      error: errorMessage,
      stack: errorStack,
      model: request.model 
    }, 'Request failed');
    res.status(500).json({
      error: {
        message: errorMessage,
        type: 'squire_error',
      },
    });
  }
});

// Start API server
const apiServer = app.listen(config.server.port, () => {
  logger.info({ port: config.server.port }, '🛡️  Squire standing ready');
  logger.info({ backend: config.backend.url }, '   Backend: LiteLLM');
  logger.info({ validation: config.validation.enabled }, '   Validation enabled');
  logger.info({ escalation: config.escalation.enabled }, '   Escalation enabled');
  logger.info({ metrics: config.metrics.enabled }, '   Metrics enabled');
});

// Start metrics server
if (config.metrics.enabled) {
  const metricsApp = express();
  metricsApp.get(config.metrics.path, async (req, res) => {
    res.set('Content-Type', metrics.register.contentType);
    res.send(await metrics.register.metrics());
  });
  
  metricsApp.listen(config.metrics.port, () => {
    logger.info({ 
      port: config.metrics.port, 
      path: config.metrics.path 
    }, '📊 Metrics server listening');
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  apiServer.close(() => {
    logger.info('API server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  apiServer.close(() => {
    logger.info('API server closed');
    process.exit(0);
  });
});
