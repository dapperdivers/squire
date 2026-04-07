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
  content: string | Array<{type: string; text?: string; [key: string]: any}>;
}

/**
 * Normalize content to a string (handles both string and multimodal array formats)
 */
function normalizeContent(content: string | Array<{type: string; text?: string; [key: string]: any}>): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part: any) => part.text || '').join(' ');
  }
  return '';
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

/**
 * Simple HTTP call to LiteLLM backend.
 * Squire doesn't know or care which provider is handling this.
 */
async function callLiteLLM(
  backendUrl: string,
  apiKey: string | undefined,
  request: ChatRequest,
  logger: Logger
): Promise<ChatResponse> {
  const url = `${backendUrl}/v1/chat/completions`;
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  
  logger.debug({ url, model: request.model }, 'Calling LiteLLM backend');
  
  // Ensure non-streaming response (LiteLLM defaults to SSE if stream not specified)
  const requestWithStream = { ...request, stream: false };
  
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestWithStream),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status, error: errorText }, 'LiteLLM request failed');
    throw new Error(`LiteLLM error: ${response.status} ${errorText}`);
  }
  
  return response.json() as Promise<ChatResponse>;
}

/**
 * Validate a response using the judge model.
 */
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
  
  logger.debug({ judgeModel: config.validation.judgeModel }, 'Validating response with judge');
  
  const judgeResponse: ChatResponse = await callLiteLLM(
    config.backend.url,
    config.backend.apiKey,
    judgeRequest,
    logger
  );
  
  const judgeOutput = judgeResponse.choices[0]?.message?.content 
    ? normalizeContent(judgeResponse.choices[0].message.content) 
    : '';
  
  // Parse JSON output
  let parsed: { score: number; reasoning: string };
  try {
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = judgeOutput.match(/```json\s*(\{[\s\S]*?\})\s*```/) ||
                      judgeOutput.match(/(\{[\s\S]*?\})/);
    const jsonStr = jsonMatch ? jsonMatch[1] : judgeOutput;
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    logger.warn({ judgeOutput }, 'Failed to parse judge output, using fallback');
    parsed = { score: 0, reasoning: 'Judge output was not valid JSON' };
  }
  
  // Estimate cost (rough approximation - LiteLLM tracks exact costs)
  const promptTokens = judgeResponse.usage?.prompt_tokens || 0;
  const completionTokens = judgeResponse.usage?.completion_tokens || 0;
  const cost = (promptTokens * 0.000001) + (completionTokens * 0.000005);
  
  metrics.validationCostTotal.inc(cost);
  
  logger.info({
    score: parsed.score,
    reasoning: parsed.reasoning,
    cost,
  }, '⚖️  Response validated');
  
  return {
    score: parsed.score,
    reasoning: parsed.reasoning,
    cost,
  };
}

/**
 * Check if we should skip validation for this request.
 */
function shouldSkipValidation(request: ChatRequest, config: SquireConfig): boolean {
  // Not in validateModels list
  if (!config.filters.validateModels.includes(request.model)) {
    return true;
  }
  
  // Get the user's last message
  const lastMessage = request.messages[request.messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    return true;
  }
  
  const question = normalizeContent(lastMessage.content).toLowerCase();
  
  // Too short
  if (question.length < config.filters.skipIf.questionLengthLessThan) {
    return true;
  }
  
  // Contains skip keyword
  for (const keyword of config.filters.skipIf.containsKeywords) {
    if (question.includes(keyword.toLowerCase())) {
      return true;
    }
  }
  
  return false;
}

/**
 * Execute request with quality-gated escalation.
 * This is the core Squire logic - everything else is delegated to LiteLLM.
 */
export async function executeWithEscalation(
  request: ChatRequest,
  config: SquireConfig,
  logger: Logger,
  metrics: Metrics
): Promise<{ response: ChatResponse; attempts: number; finalScore: number | null }> {
  const originalModel = request.model;
  
  // Check skip filters
  if (shouldSkipValidation(request, config)) {
    // If model has escalation path, use first tier (router model names don't exist in LiteLLM)
    const escalationPath = config.escalation.paths[originalModel];
    const modelToUse = escalationPath && escalationPath.length > 0 
      ? escalationPath[0].model 
      : originalModel;
    
    logger.info({ 
      model: originalModel, 
      resolvedTo: modelToUse 
    }, 'Skipping validation (filter matched), passing through');
    
    const passthroughRequest = { ...request, model: modelToUse };
    const response = await callLiteLLM(config.backend.url, config.backend.apiKey, passthroughRequest, logger);
    metrics.requestsTotal.inc({ model: originalModel, result: 'passthrough' });
    return { response, attempts: 1, finalScore: null };
  }
  
  // Get escalation path
  const escalationPath = config.escalation.paths[originalModel];
  
  if (!escalationPath) {
    logger.info({ model: originalModel }, 'No escalation path, passing through');
    const response = await callLiteLLM(config.backend.url, config.backend.apiKey, request, logger);
    metrics.requestsTotal.inc({ model: originalModel, result: 'no_escalation' });
    return { response, attempts: 1, finalScore: null };
  }
  
  // Walk escalation path
  let attempts = 0;
  let lastResponse: ChatResponse | null = null;
  let lastScore: number | null = null;
  
  const lastMessage = request.messages[request.messages.length - 1];
  const question = lastMessage ? normalizeContent(lastMessage.content) : '';
  
  for (let i = 0; i < escalationPath.length && attempts < config.escalation.maxAttempts; i++) {
    const step = escalationPath[i];
    attempts++;
    
    const tierRequest = { ...request, model: step.model };
    
    logger.info({ 
      attempt: attempts, 
      model: step.model, 
      threshold: step.threshold 
    }, `⚔️  Attempting with ${step.model}`);
    
    const startTime = Date.now();
    
    try {
      const response = await callLiteLLM(
        config.backend.url,
        config.backend.apiKey,
        tierRequest,
        logger
      );
      
      const duration = (Date.now() - startTime) / 1000;
      metrics.requestDuration.observe({ model: step.model, result: 'success' }, duration);
      
      lastResponse = response;
      const responseText = response.choices[0]?.message?.content
        ? normalizeContent(response.choices[0].message.content)
        : '';
      
      // Terminal model or validation disabled?
      if (step.threshold === null || !config.validation.enabled) {
        logger.info({ model: step.model }, 
                     '🛡️  Terminal model or validation disabled - accepting');
        metrics.requestsTotal.inc({ model: step.model, result: 'accepted' });
        return { response, attempts, finalScore: lastScore };
      }
      
      // Validate
      const validation = await validateResponse(question, responseText, config, logger, metrics);
      lastScore = validation.score;
      
      metrics.validationScore.observe({ model: step.model }, validation.score);
      
      if (validation.score >= step.threshold) {
        const modelNickname = step.model.split('/').pop() || step.model;
        logger.info({ 
          model: step.model, 
          score: validation.score, 
          threshold: step.threshold 
        }, `🛡️  Sir ${modelNickname}'s answer meets the standard (${validation.score}/${step.threshold})`);
        
        metrics.requestsTotal.inc({ model: step.model, result: 'accepted' });
        return { response, attempts, finalScore: validation.score };
      }
      
      logger.warn({
        model: step.model,
        score: validation.score,
        threshold: step.threshold,
        reasoning: validation.reasoning,
      }, `⚔️  Answer falls short (${validation.score}/${step.threshold})`);
      
      // Escalate to next tier
      if (i < escalationPath.length - 1) {
        const nextStep = escalationPath[i + 1];
        metrics.escalationsTotal.inc({ from: step.model, to: nextStep.model });
        logger.info({ from: step.model, to: nextStep.model }, 
                     '🔥 Escalating to stronger model');
      }
      
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      metrics.requestDuration.observe({ model: step.model, result: 'error' }, duration);
      
      logger.error({ error, model: step.model, attempt: attempts }, 
                    'Request failed');
      
      // If not last tier, try next
      if (i < escalationPath.length - 1) {
        logger.info('Escalating due to error');
        continue;
      }
      
      throw error;
    }
  }
  
  // Exhausted all tiers
  if (lastResponse) {
    logger.warn({ attempts, finalScore: lastScore }, 
                 '⚠️  All tiers exhausted. Returning best attempt.');
    metrics.requestsTotal.inc({ model: originalModel, result: 'exhausted' });
    return { response: lastResponse, attempts, finalScore: lastScore };
  }
  
  throw new Error('All escalation tiers failed');
}
