import { providerRegistry } from "../provider-registry";
import { sourceAdapters } from "./adapters";
import type { Cadence, SourceAdapter } from "./types";

const cadenceMinutes: Record<Cadence, number> = { fast: 10, slow: 60, satellite: 120, daily: 1440 };

export function sourceRuntimeProblems(): string[] {
  const problems: string[] = [];
  const adaptersBySource = new Map<string, SourceAdapter[]>();
  for (const adapter of sourceAdapters) {
    const existing = adaptersBySource.get(adapter.id) || [];
    adaptersBySource.set(adapter.id, [...existing, adapter]);
  }

  const providersBySource = new Map<string, Array<(typeof providerRegistry)[keyof typeof providerRegistry]>>();
  for (const provider of Object.values(providerRegistry)) {
    providersBySource.set(provider.sourceId, [...(providersBySource.get(provider.sourceId) || []), provider]);
  }

  for (const [providerId, provider] of Object.entries(providerRegistry)) {
    const adapters = adaptersBySource.get(provider.sourceId) || [];
    if (provider.mode === "disabled") {
      if (adapters.length) problems.push(`Disabled provider ${providerId} has a scheduled adapter`);
      continue;
    }
    if (adapters.length !== 1) problems.push(`Enabled provider ${providerId} requires exactly one adapter; found ${adapters.length}`);
    const adapter = adapters[0];
    if (adapter && provider.cadenceMinutes !== cadenceMinutes[adapter.cadence]) {
      problems.push(`Provider ${providerId} cadence ${provider.cadenceMinutes} does not match adapter cadence ${adapter.cadence}`);
    }
  }

  for (const adapter of sourceAdapters) {
    const providers = providersBySource.get(adapter.id) || [];
    if (providers.length !== 1) problems.push(`Adapter ${adapter.id} requires exactly one provider; found ${providers.length}`);
  }
  return problems.sort();
}

export function assertSourceRuntimeIntegrity() {
  const problems = sourceRuntimeProblems();
  if (problems.length) throw new Error(`Invalid source runtime manifest:\n${problems.join("\n")}`);
}
