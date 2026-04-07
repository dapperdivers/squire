import type { Logger } from './logger.js';

export interface ChatMessage {
  role: string;
  content: string | Array<{type: string; text?: string; [key: string]: any}>;
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
 * Normalize content to a string (handles both string and multimodal array formats)
 */
export function normalizeContent(content: string | Array<{type: string; text?: string; [key: string]: any}>): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part: any) => part.text || '').join(' ');
  }
  return '';
}

/**
 * Shared LiteLLM backend call
 */
export async function callLiteLLM(
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
