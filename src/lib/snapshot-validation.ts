import catalogV2 from "../../data/catalog-releases/2.json";
import { SnapshotV10Schema } from "./domain/schemas";

const expectedLocationIds = new Set(catalogV2.locationIds);

export const CompleteSnapshotV10Schema = SnapshotV10Schema.superRefine((snapshot, context) => {
  const actualIds = Object.keys(snapshot.locations);
  if (actualIds.length !== expectedLocationIds.size || actualIds.some((id) => !expectedLocationIds.has(id))) {
    context.addIssue({ code: "custom", path: ["locations"], message: "Snapshot must contain exactly the configured locations" });
  }
});

export const CompleteSnapshotSchema = CompleteSnapshotV10Schema;
