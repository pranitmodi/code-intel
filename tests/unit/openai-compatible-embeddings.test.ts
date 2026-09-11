import { describe, expect, it, vi } from 'vitest';
import {
  EmbeddingConfigurationError,
  OpenAICompatibleEmbeddingProvider,
  isEmbeddingInputTooLargeError,
  resolveEmbeddingsEndpoint
} from '../../src/embeddings/OpenAICompatibleEmbeddingProvider.js';

function embeddingResponse(vectors: Array<{ index: number; embedding: number[] }>): Response {
  return new Response(JSON.stringify({ object: 'list', data: vectors }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('OpenAICompatibleEmbeddingProvider', () => {
  it('batches requests, sends proxy fields, and restores response index order', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        embeddingResponse([
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] }
        ])
      )
      .mockResolvedValueOnce(embeddingResponse([{ index: 0, embedding: [0, 0, 1] }]));
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://proxy.example/',
      apiKey: 'secret-key',
      user: 'user@example.com',
      model: 'Qwen3-Embedding-8B',
      batchSize: 2,
      fetch: fetchMock
    });

    await expect(provider.embedBatch(['one', 'two', 'three'])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://proxy.example/embeddings');

    const firstInit = fetchMock.mock.calls[0]?.[1];
    expect(firstInit?.headers).toEqual({
      Authorization: 'Bearer secret-key',
      'Content-Type': 'application/json'
    });
    expect(JSON.parse(String(firstInit?.body))).toEqual({
      model: 'Qwen3-Embedding-8B',
      input: ['one', 'two'],
      user: 'user@example.com'
    });
  });

  it('retries the transient proxy failures that abort long index runs', async () => {
    const timeoutBody = JSON.stringify({ error: { message: 'litellm.Timeout: Timeout Error' } });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockResolvedValueOnce(new Response(timeoutBody, { status: 408, statusText: 'Request Timeout' }))
      .mockResolvedValueOnce(embeddingResponse([{ index: 0, embedding: [1, 2, 3] }]));
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://proxy.example',
      apiKey: 'secret-key',
      model: 'Qwen3-Embedding-8B',
      fetch: fetchMock,
      retryBaseDelayMs: 0
    });

    await expect(provider.embedBatch(['one'])).resolves.toEqual([[1, 2, 3]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a rejected key', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { status: 403, statusText: 'Forbidden' }));
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://proxy.example',
      apiKey: 'secret-key',
      model: 'Qwen3-Embedding-8B',
      fetch: fetchMock,
      retryBaseDelayMs: 0
    });

    await expect(provider.embedBatch(['one'])).rejects.toThrow(/rejected the credentials/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies only context-window 400 responses as oversized input', async () => {
    const contextFailure = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://proxy.example',
      apiKey: 'secret-key',
      model: 'Qwen3-Embedding-8B',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: 'ContextWindowExceededError: maximum context length is 40960 input tokens' } }),
          { status: 400, statusText: 'Bad Request' }
        )
      )
    });
    const ordinaryBadRequest = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://proxy.example',
      apiKey: 'secret-key',
      model: 'Qwen3-Embedding-8B',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('invalid model parameter', { status: 400, statusText: 'Bad Request' })
      )
    });

    const oversized = await contextFailure.embed('one').catch((error: unknown) => error);
    const ordinary = await ordinaryBadRequest.embed('one').catch((error: unknown) => error);
    expect(isEmbeddingInputTooLargeError(oversized)).toBe(true);
    expect(isEmbeddingInputTooLargeError(ordinary)).toBe(false);
  });

  it('probes dimensions only once', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      embeddingResponse([{ index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }])
    );
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://proxy.example',
      apiKey: 'key',
      user: 'user',
      model: 'model',
      fetch: fetchMock
    });

    await expect(provider.dimensions()).resolves.toBe(4);
    await expect(provider.dimensions()).resolves.toBe(4);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries transient failures and does not expose the API key in errors', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(embeddingResponse([{ index: 0, embedding: [1, 2] }]));
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://proxy.example',
      apiKey: 'never-print-this',
      user: 'user',
      model: 'model',
      maxRetries: 1,
      retryBaseDelayMs: 0,
      fetch: fetchMock
    });

    await expect(provider.embed('query')).resolves.toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response('request using never-print-this was denied', { status: 400, statusText: 'Bad Request' })
    );
    await expect(provider.embed('query')).rejects.not.toThrow('never-print-this');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('requires credentials and validates response dimensions', async () => {
    expect(
      () =>
        new OpenAICompatibleEmbeddingProvider({
          baseUrl: 'https://proxy.example',
          apiKey: '',
          user: 'user',
          model: 'model'
        })
    ).toThrow(EmbeddingConfigurationError);

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://proxy.example',
      apiKey: 'key',
      user: 'user',
      model: 'model',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        embeddingResponse([
          { index: 0, embedding: [1, 2] },
          { index: 1, embedding: [3] }
        ])
      )
    });
    await expect(provider.embedBatch(['one', 'two'])).rejects.toThrow('inconsistent dimensions');
  });

  it('omits user when unset and honors a custom embeddings path', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      embeddingResponse([{ embedding: [9, 8], index: 0 }])
    );
    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'key',
      model: 'text-embedding-3-small',
      embeddingsPath: '/embeddings',
      fetch: fetchMock
    });

    await expect(provider.embed('hello')).resolves.toEqual([9, 8]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/embeddings');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'text-embedding-3-small',
      input: ['hello']
    });
  });
});

describe('resolveEmbeddingsEndpoint', () => {
  it('joins origin + path and does not double-append /embeddings', () => {
    expect(resolveEmbeddingsEndpoint('https://proxy.example', '/embeddings')).toBe(
      'https://proxy.example/embeddings'
    );
    expect(resolveEmbeddingsEndpoint('https://proxy.example/v1/embeddings/', '/embeddings')).toBe(
      'https://proxy.example/v1/embeddings'
    );
  });
});
