import { config, isAiConfigured } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

/** Error carrying an HTTP status so routes can translate it into a response. */
export class MiniMaxError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'MiniMaxError';
    this.status = status;
  }
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Calls MiniMax-M3 through NVIDIA's OpenAI-compatible chat-completions endpoint
 * and returns the assistant's message text. The API key never leaves the server.
 */
export async function chatCompletion(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  if (!isAiConfigured()) {
    throw new MiniMaxError('AI is not configured: NVIDIA_API_KEY is missing on the server.', 503);
  }

  let res: Response;
  try {
    res = await fetch(`${config.nvidia.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.nvidia.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: config.nvidia.model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.7,
        top_p: opts.topP ?? 0.95,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.nvidia.timeoutMs),
    });
  } catch (cause) {
    if ((cause as Error).name === 'TimeoutError') {
      throw new MiniMaxError(`MiniMax request timed out after ${config.nvidia.timeoutMs}ms.`, 504);
    }
    throw new MiniMaxError(`Could not reach the MiniMax API: ${(cause as Error).message}`, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new MiniMaxError(
      `MiniMax request failed (${res.status} ${res.statusText})${detail ? `: ${detail.slice(0, 400)}` : ''}`,
      res.status === 401 ? 502 : 502,
    );
  }

  const data = (await res.json().catch(() => ({}))) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new MiniMaxError('MiniMax returned an empty response.', 502);
  }
  return content;
}
