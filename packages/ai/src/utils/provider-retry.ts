const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
	/** HTTP statuses that fail at once although the default policy would retry them. */
	noRetryStatuses?: readonly number[];
	/**
	 * Optional retry budget for pre-response socket/transport failures (e.g. ECONNRESET on a stale
	 * keep-alive connection) even when HTTP `maxRetries` is 0 or unset.
	 */
	transportRetries?: number;
}

interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

const RETRYABLE_TRANSPORT_ERROR_PATTERN =
	/(?<![a-z0-9_])(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)(?![a-z0-9_])|socket hang up|socket connection was closed|other side closed|connection reset by peer|fetch failed/i;

function isRetryableTransportError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if ("status" in error && typeof (error as { status?: unknown }).status === "number") return false;
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
		const code = (current as Error & { code?: unknown }).code;
		if (typeof code === "string" && RETRYABLE_TRANSPORT_ERROR_PATTERN.test(code)) return true;
		if (RETRYABLE_TRANSPORT_ERROR_PATTERN.test(current.message)) return true;
		current = current.cause;
	}
	return false;
}

function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	if (error.status === undefined) return true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(typeof error.status === "number" && error.status >= 500)
	);
}

function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	providerErrorMessage: string,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		throw new Error(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`,
		);
	}
	return delayMs;
}

function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
	}

	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs)) return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
	}

	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError());
		};
		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export async function retryProviderRequest<T>(
	request: (context: { attempt: number; isRetry: boolean }) => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	const maxTransportRetries = options.transportRetries ?? maxRetries;
	let providerRetriesRemaining = maxRetries;
	let transportRetriesRemaining = maxTransportRetries;
	let attempt = 0;

	for (;;) {
		try {
			// Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
			return await request({ attempt, isRetry: attempt > 0 });
		} catch (error) {
			if (options.signal?.aborted) throw createAbortError();

			if (isProviderError(error)) {
				if (providerRetriesRemaining <= 0 || !isRetryableProviderError(error)) throw error;
				if (error.status !== undefined && options.noRetryStatuses?.includes(error.status)) throw error;

				const retryIndex = maxRetries - providerRetriesRemaining;
				providerRetriesRemaining--;
				attempt++;
				await abortableSleep(getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs), options.signal);
				continue;
			}

			if (transportRetriesRemaining > 0 && isRetryableTransportError(error)) {
				const retryIndex = maxTransportRetries - transportRetriesRemaining;
				transportRetriesRemaining--;
				attempt++;
				const backoffMs = Math.min(250 * 2 ** retryIndex, 2000) * (1 - Math.random() * 0.25);
				await abortableSleep(backoffMs, options.signal);
				continue;
			}

			throw error;
		}
	}
}
