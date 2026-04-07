import type { Logger } from './logger.js';
import type { SquireConfig } from './config.js';
import type { ChatMessage, ChatRequest, ChatResponse } from './judge.js';

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

/**
 * Call LiteLLM backend
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

export interface ComplexityResult {
  complexity: 'simple' | 'moderate' | 'complex';
  reasoning: string;
  recommendedModel: string;
}

/**
 * Use Haiku to classify task complexity and route to appropriate model
 */
export async function classifyAndRoute(
  request: ChatRequest,
  config: SquireConfig,
  logger: Logger
): Promise<ComplexityResult> {
  // Extract user message only
  const lastMessage = request.messages[request.messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    throw new Error('No user message found in request');
  }
  
  const userMessage = normalizeContent(lastMessage.content);
  
  // Classifier prompt
  const classifierPrompt = `You are a task complexity classifier. Analyze this user request and determine its complexity level.

User request: "${userMessage}"

Classify as:
- simple: Basic factual questions, greetings, simple definitions (use gemma-local)
- moderate: Explanations, comparisons, multi-step reasoning (use nemotron)  
- complex: Deep analysis, creative work, coding, nuanced judgment (use claude-sonnet)

Respond ONLY with valid JSON:
{
  "complexity": "simple|moderate|complex",
  "reasoning": "brief explanation",
  "recommendedModel": "gemma-local|nemotron|claude-sonnet"
}`;

  const classifierRequest: ChatRequest = {
    model: 'claude-haiku',
    messages: [{ role: 'user', content: classifierPrompt }],
    temperature: 0,
    max_tokens: 200,
  };
  
  logger.info({ userMessage: userMessage.substring(0, 100) }, '🧭 Classifying task complexity');
  
  try {
    const response = await callLiteLLM(
      config.backend.url,
      config.backend.apiKey,
      classifierRequest,
      logger
    );
    
    const output = response.choices[0]?.message?.content
      ? normalizeContent(response.choices[0].message.content)
      : '';
    
    // Parse JSON
    const jsonMatch = output.match(/```json\s*(\{[\s\S]*?\})\s*```/) ||
                      output.match(/(\{[\s\S]*?\})/);
    const jsonStr = jsonMatch ? jsonMatch[1] : output;
    const result = JSON.parse(jsonStr) as ComplexityResult;
    
    logger.info({
      complexity: result.complexity,
      model: result.recommendedModel,
      reasoning: result.reasoning
    }, '🧭 Task classified');
    
    return result;
    
  } catch (error) {
    logger.warn({ error }, 'Classifier failed, defaulting to moderate complexity');
    return {
      complexity: 'moderate',
      reasoning: 'Classifier error - using safe default',
      recommendedModel: 'nemotron'
    };
  }
}

/**
 * Execute request with intelligent routing (no retries, no validation loops)
 */
export async function executeWithRouting(
  request: ChatRequest,
  config: SquireConfig,
  logger: Logger
): Promise<{ response: ChatResponse; complexity: string; routedModel: string }> {
  // Classify task
  const classification = await classifyAndRoute(request, config, logger);
  
  // Route to recommended model
  const routedRequest = { ...request, model: classification.recommendedModel };
  
  logger.info({
    originalModel: request.model,
    routedModel: classification.recommendedModel,
    complexity: classification.complexity
  }, '🎯 Routing request');
  
  // Single attempt - no retries
  const response = await callLiteLLM(
    config.backend.url,
    config.backend.apiKey,
    routedRequest,
    logger
  );
  
  return {
    response,
    complexity: classification.complexity,
    routedModel: classification.recommendedModel
  };
}
