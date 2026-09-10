import { catalogV2CountryCodes } from "@/lib/domain/contract-identities";
import { parseCatalogState } from "@/lib/domain/catalog-state";
import { IngestionStateV12Schema } from "@/lib/domain/schemas";
import { createEmptyState } from "@/lib/risk";

// Historical wire fixtures must remain28-country V12 even when runtime state grows.
export function projectLegacyState(value: unknown) {
  const state = parseCatalogState(value);
  const countries = (groups: Record<string, Record<string, unknown>>) => Object.fromEntries(Object.entries(groups).map(([source, values]) => [
    source, Object.fromEntries(catalogV2CountryCodes.map((code) => [code, values[code]])),
  ]));
  return IngestionStateV12Schema.parse({ ...state, schemaVersion: 12,
    sourcePartitions: countries(state.sourcePartitions), partitionTransports: countries(state.partitionTransports),
  });
}

export function createLegacyState(now: Date) { return projectLegacyState(createEmptyState(now)); }
