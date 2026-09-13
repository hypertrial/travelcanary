export async function fetchHealth(port, options = {}) {
  const deadline = Date.now() + (options.deadlineMs ?? 15_000);
  const requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
  const retryMs = options.retryMs ?? 500;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw lastError ?? new Error("Health request deadline exceeded");
    try {
      return await fetchImpl(`http://127.0.0.1:${port}/api/v1/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remainingMs))),
      });
    } catch (error) {
      lastError = error;
      const retryBudgetMs = deadline - Date.now();
      if (retryBudgetMs <= 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryMs, retryBudgetMs)));
    }
  }
}
