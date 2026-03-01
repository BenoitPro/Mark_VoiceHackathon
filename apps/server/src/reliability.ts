type RetryOptions = {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
};

type CircuitBreakerOptions = {
  failureThreshold: number;
  cooldownMs: number;
};

type CircuitState = "closed" | "open" | "half_open";

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function withRetries<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retries = Math.max(0, options.retries);
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 2_000;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const shouldRetry = options.shouldRetry ? options.shouldRetry(error) : true;
      if (!shouldRetry || attempt === retries) {
        throw error;
      }
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unknown retry failure");
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private nextTryAtMs = 0;

  constructor(private readonly options: CircuitBreakerOptions) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() < this.nextTryAtMs) {
        throw new Error("Provider temporarily unavailable. Circuit breaker is open.");
      }
      this.state = "half_open";
    }

    try {
      const result = await operation();
      this.reset();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private recordFailure(): void {
    this.failureCount += 1;
    if (this.failureCount >= this.options.failureThreshold) {
      this.state = "open";
      this.nextTryAtMs = Date.now() + this.options.cooldownMs;
    }
  }

  private reset(): void {
    this.failureCount = 0;
    this.state = "closed";
    this.nextTryAtMs = 0;
  }
}

export function isRetriableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("temporarily unavailable") ||
    message.includes("429") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("network") ||
    message.includes("fetch")
  );
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
