import type { Logger } from './logger.js';
import type { SquireConfig } from './config.js';
import type { Metrics } from './metrics.js';

export interface ValidationResult {
  score: number;
  reasoning: string;
  cost: number;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function callLiteLLM(
  endpoint: string,
  apiKey: string | undefined,
  request: ChatRequest,
  logger: Logger
): Promise<ChatResponse> {
  const url = `${endpoint}/v1/chat/completions`;
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  
  logger.debug({ url, model: request.model }, 'Calling LiteLLM');
  
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status, error: errorText }, 'LiteLLM request failed');
    throw new Error(`LiteLLM error: ${response.status} ${errorText}`);
  }
  
  return response.json();
}

export async function validateResponse(
  question: string,
  response: string,
  config: SquireConfig,
  logger: Logger,
  metrics: Metrics
): Promise<ValidationResult> {
  const prompt = config.validation.judgePrompt
    .replace('{question}', question)
    .replace('{response}', response);
  
  const judgeRequest: ChatRequest = {
    model: config.validation.judgeModel,
    messages: [
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: 500,
  };
  
  logger.debug({ judgeModel: config.validation.judgeModel }, 'Validating response');
  
  const judgeResponse = await callLiteLLM(
    config.litellm.endpoint,
    config.litellm.apiKey,
    judgeRequest,
    logger
  );
  
  const judgeOutput = judgeResponse.choices[0]?.message?.content || '';
  
  // Parse JSON output
  let parsed: { score: number; reasoning: string };
  try {
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = judgeOutput.match(/```json\s*(\{[\s\S]*?\})\s*```/) ||
                      judgeOutput.match(/(\{[\s\S]*?\})/);
    const jsonStr = jsonMatch ? jsonMatch[1] : judgeOutput;
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    logger.warn({ judgeOutput }, 'Failed to parse judge output as JSON, using fallback');
    parsed = { score: 0, reasoning: 'Judge output was not valid JSON' };
  }
  
  // Estimate cost (Haiku: ~$1/$5 per million tokens)
  const promptTokens = judgeResponse.usage?.prompt_tokens || 0;
  const completionTokens = judgeResponse.usage?.completion_tokens || 0;
  const cost = (promptTokens * 0.000001) + (completionTokens * 0.000005);
  
  metrics.validationCostTotal.inc(cost);
  
  logger.info({
    score: parsed.score,
    reasoning: parsed.reasoning,
    cost,
  }, '⚖️  [Squire] Response validated');
  
  return {
    score: parsed.score,
    reasoning: parsed.reasoning,
    cost,
  };
}

export async function executeWithEscalation(
  request: ChatRequest,
  config: SquireConfig,
  logger: Logger,
  metrics: Metrics
): Promise<{ response: ChatResponse; attempts: number; finalScore: number | null }> {
  const originalModel = request.model;
  const escalationPath = config.escalation.paths[originalModel];
  
  if (!escalationPath) {
    logger.warn({ model: originalModel }, 'No escalation path found, executing without validation');
    const response = await callLiteLLM(config.litellm.endpoint, config.litellm.apiKey, request, logger);
    metrics.requestsTotal.inc({ model: originalModel, result: 'no_escalation' });
    return { response, attempts: 1, finalScore: null };
  }
  
  let attempts = 0;
  let lastResponse: ChatResponse | null = null;
  let lastScore: number | null = null;
  let currentTierIndex = 0;
  
  const question = request.messages[request.messages.length - 1]?.content || '';
  
  while (attempts < config.escalation.maxAttempts && currentTierIndex < escalationPath.length) {
    const tier = escalationPath[currentTierIndex];
    attempts++;
    
    const tierRequest = { ...request, model: tier.model };
    
    logger.info({ attempt: attempts, model: tier.model, threshold: tier.threshold }, 
                 `⚔️  [Squire] Attempting with ${tier.model}`);
    
    const startTime = Date.now();
    
    try {
      const response = await callLiteLLM(
        config.litellm.endpoint,
        config.litellm.apiKey,
        tierRequest,
        logger
      );
      
      const duration = (Date.now() - startTime) / 1000;
      metrics.requestDuration.observe({ model: tier.model, result: 'success' }, duration);
      
      lastResponse = response;
      const responseText = response.choices[0]?.message?.content || '';
      
      // If this is the last tier or threshold is null, accept without validation
      if (tier.threshold === null || currentTierIndex === escalationPath.length - 1) {
        logger.info({ model: tier.model }, 
                     '🛡️  [Squire] Using highest tier or last resort - accepting without validation');
        metrics.requestsTotal.inc({ model: tier.model, result: 'accepted' });
        return { response, attempts, finalScore: lastScore };
      }
      
      // Validate
      if (config.validation.enabled) {
        const validation = await validateResponse(question, responseText, config, logger, metrics);
        lastScore = validation.score;
        
        metrics.validationScore.observe({ model: tier.model }, validation.score);
        
        if (validation.score >= tier.threshold) {
          logger.info({ 
            model: tier.model, 
            score: validation.score, 
            threshold: tier.threshold 
          }, `🛡️  [Squire] Sir ${tier.model.split('/').pop()}'s answer meets the standard. The king shall hear it.`);
          
          metrics.requestsTotal.inc({ model: tier.model, result: 'accepted' });
          return { response, attempts, finalScore: validation.score };
        }
        
        logger.warn({
          model: tier.model,
          score: validation.score,
          threshold: tier.threshold,
          reasoning: validation.reasoning,
        }, `⚔️  [Squire] Answer falls short (score: ${validation.score}/${tier.threshold}). Demanding a worthier response.`);
        
        // Escalate
        if (currentTierIndex < escalationPath.length - 1) {
          const nextTier = escalationPath[currentTierIndex + 1];
          metrics.escalationsTotal.inc({ from: tier.model, to: nextTier.model });
          logger.info({ from: tier.model, to: nextTier.model }, 
                       '🔥 [Squire] Escalating to stronger ally');
        }
      }
      
      currentTierIndex++;
      
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      metrics.requestDuration.observe({ model: tier.model, result: 'error' }, duration);
      
      logger.error({ error, model: tier.model, attempt: attempts }, 
                    'Request failed, escalating');
      
      currentTierIndex++;
    }
  }
  
  // If we exhausted all tiers, return the last response
  if (lastResponse) {
    logger.warn({ attempts, finalScore: lastScore }, 
                 '⚠️  [Squire] All attempts exhausted. Presenting the best attempt.');
    metrics.requestsTotal.inc({ model: originalModel, result: 'exhausted' });
    return { response: lastResponse, attempts, finalScore: lastScore };
  }
  
  throw new Error('All escalation tiers failed');
}
