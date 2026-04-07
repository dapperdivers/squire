import express from 'express';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { executeWithEscalation, type ChatRequest } from './judge.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const metrics = createMetrics(config);
  
  logger.info({ config: config.server }, `🛡️  Starting Squire - The Quality Sentinel`);
  
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  
  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'healthy', realm: config.server.realm });
  });
  
  // Chat completions endpoint
  app.post('/v1/chat/completions', async (req, res) => {
    const requestStart = Date.now();
    metrics.activeRequests.inc();
    
    try {
      const chatRequest = req.body as ChatRequest;
      
      // Check for skip validation header
      const skipValidation = req.headers['x-squire-skip-validation'] === 'true';
      
      if (skipValidation) {
        logger.info({ model: chatRequest.model }, 'Validation skipped by request header');
        
        const response = await fetch(`${config.litellm.endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.litellm.apiKey ? { 'Authorization': `Bearer ${config.litellm.apiKey}` } : {}),
          },
          body: JSON.stringify(chatRequest),
        });
        
        const data = await response.json();
        return res.json(data);
      }
      
      // Execute with escalation
      const result = await executeWithEscalation(chatRequest, config, logger, metrics);
      
      // Add squire metadata to response
      const responseWithMeta = {
        ...result.response,
        squire: {
          attempts: result.attempts,
          finalScore: result.finalScore,
          originalModel: chatRequest.model,
          actualModel: result.response.model,
        },
      };
      
      res.json(responseWithMeta);
      
    } catch (error) {
      logger.error({ error }, 'Request failed');
      res.status(500).json({ 
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          type: 'squire_error',
        },
      });
    } finally {
      metrics.activeRequests.dec();
      const duration = (Date.now() - requestStart) / 1000;
      logger.debug({ duration }, 'Request completed');
    }
  });
  
  // Start main server
  app.listen(config.server.port, () => {
    logger.info({ port: config.server.port }, `🏰 Squire listening on port ${config.server.port}`);
  });
  
  // Start metrics server
  if (config.metrics.enabled) {
    const metricsApp = express();
    
    metricsApp.get(config.metrics.path, async (req, res) => {
      res.set('Content-Type', metrics.register.contentType);
      res.send(await metrics.register.metrics());
    });
    
    metricsApp.listen(config.metrics.port, () => {
      logger.info({ port: config.metrics.port, path: config.metrics.path }, 
                   `📊 Metrics exposed on port ${config.metrics.port}${config.metrics.path}`);
    });
  }
  
  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
