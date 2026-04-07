import type { Logger } from './logger.js';
import type { SquireConfig } from './config.js';
import type { Metrics } from './metrics.js';
import { callLiteLLM, normalizeContent } from './shared.js';
import type { ChatRequest, ChatResponse } from './shared.js';

export interface ComplexityResult {
  complexity: 'simple' | 'moderate' | 'complex';
  reasoning: string;
  recommendedModel: string;
}

/**
 * Check if we should skip routing/classification for this request
 */
export function shouldSkipRouting(request: ChatRequest, config: SquireConfig): boolean {
  // Get the user's last message
  const lastMessage = request.messages[request.messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    return true;
  }
  
  const question = normalizeContent(lastMessage.content).toLowerCase();
  
  // Too short - skip Haiku cost, go straight to gemma-local
  if (question.length < config.filters.skipIf.questionLengthLessThan) {
    return true;
  }
  
  // Contains skip keyword - simple greeting/acknowledgment
  for (const keyword of config.filters.skipIf.containsKeywords) {
    if (question.includes(keyword.toLowerCase())) {
      return true;
    }
  }
  
  return false;
}

/**
 * Use Haiku to classify task complexity and route to appropriate model
 */
export async function classifyAndRoute(
  request: ChatRequest,
  config: SquireConfig,
  logger: Logger,
  metrics: Metrics
): Promise<ComplexityResult> {
  // Extract user message only
  const lastMessage = request.messages[request.messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    throw new Error('No user message found in request');
  }
  
  const userMessage = normalizeContent(lastMessage.content);
  
  // Get classifier prompt from config (or use default)
  const classifierPromptTemplate = config.routing?.classifierPrompt || `You are a task complexity classifier. Analyze this user request and determine its complexity level.

User request: "{question}"

Classify as:
- simple: Basic factual questions, greetings, simple definitions (use {simpleModel})
- moderate: Explanations, comparisons, multi-step reasoning (use {moderateModel})  
- complex: Deep analysis, creative work, coding, nuanced judgment (use {complexModel})

Respond ONLY with valid JSON:
{
  "complexity": "simple|moderate|complex",
  "reasoning": "brief explanation",
  "recommendedModel": "{simpleModel}|{moderateModel}|{complexModel}"
}`;

  const simpleModel = config.routing?.models?.simple || 'gemma-local';
  const moderateModel = config.routing?.models?.moderate || 'nemotron';
  const complexModel = config.routing?.models?.complex || 'claude-sonnet';
  
  const classifierPrompt = classifierPromptTemplate
    .replace(/{question}/g, userMessage)
    .replace(/{simpleModel}/g, simpleModel)
    .replace(/{moderateModel}/g, moderateModel)
    .replace(/{complexModel}/g, complexModel);

  const classifierRequest: ChatRequest = {
    model: 'claude-haiku',
    messages: [{ role: 'user', content: classifierPrompt }],
    temperature: 0,
    max_tokens: 200,
  };
  
  logger.info({ userMessage: userMessage.substring(0, 100) }, '🧭 Classifying task complexity');
  
  try {
    const startTime = Date.now();
    const response = await callLiteLLM(
      config.backend.url,
      config.backend.apiKey,
      classifierRequest,
      logger
    );
    const duration = (Date.now() - startTime) / 1000;
    
    const output = response.choices[0]?.message?.content
      ? normalizeContent(response.choices[0].message.content)
      : '';
    
    // Parse JSON
    const jsonMatch = output.match(/```json\s*(\{[\s\S]*?\})\s*```/) ||
                      output.match(/(\{[\s\S]*?\})/);
    const jsonStr = jsonMatch ? jsonMatch[1] : output;
    const result = JSON.parse(jsonStr) as ComplexityResult;
    
    // Record metrics
    metrics.routingClassifications.inc({ complexity: result.complexity });
    metrics.routingDuration.observe(duration);
    
    logger.info({
      complexity: result.complexity,
      model: result.recommendedModel,
      reasoning: result.reasoning
    }, '🧭 Task classified');
    
    return result;
    
  } catch (error) {
    logger.warn({ error }, 'Classifier failed, defaulting to simple (gemma-local)');
    metrics.routingErrors.inc();
    return {
      complexity: 'simple',
      reasoning: 'Classifier error - using safe default',
      recommendedModel: simpleModel
    };
  }
}

/**
 * Execute request with intelligent routing
 * @param skipClassifier - if true, go straight to simple model (skip Haiku cost)
 */
export async function executeWithRouting(
  request: ChatRequest,
  config: SquireConfig,
  logger: Logger,
  metrics: Metrics,
  skipClassifier: boolean = false
): Promise<{ response: ChatResponse; complexity: string; routedModel: string }> {
  
  let classification: ComplexityResult;
  
  if (skipClassifier) {
    // Skip Haiku classification, use simple model directly
    const simpleModel = config.routing?.models?.simple || 'gemma-local';
    classification = {
      complexity: 'simple',
      reasoning: 'Skipped classification (trivial request)',
      recommendedModel: simpleModel
    };
    logger.info({ model: simpleModel }, '⚡ Skip filters matched - routing to simple model');
    metrics.routingSkipped.inc();
  } else {
    // Classify task complexity
    classification = await classifyAndRoute(request, config, logger, metrics);
  }
  
  // Route to recommended model
  const routedRequest = { ...request, model: classification.recommendedModel };
  
  logger.info({
    originalModel: request.model,
    routedModel: classification.recommendedModel,
    complexity: classification.complexity
  }, '🎯 Routing request');
  
  // Single attempt - no retries
  const startTime = Date.now();
  
  try {
    const response = await callLiteLLM(
      config.backend.url,
      config.backend.apiKey,
      routedRequest,
      logger
    );
    
    const duration = (Date.now() - startTime) / 1000;
    metrics.requestDuration.observe({ model: classification.recommendedModel, result: 'success' }, duration);
    metrics.requestsTotal.inc({ model: classification.recommendedModel, result: 'success' });
    
    return {
      response,
      complexity: classification.complexity,
      routedModel: classification.recommendedModel
    };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    metrics.requestDuration.observe({ model: classification.recommendedModel, result: 'error' }, duration);
    metrics.requestsTotal.inc({ model: classification.recommendedModel, result: 'error' });
    throw error;
  }
}
