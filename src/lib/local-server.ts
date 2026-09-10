import { initializeLocalRuntime, LocalDatabase } from "./local-storage";

let localDatabase: LocalDatabase | undefined;

export function getLocalDatabase() {
  if (process.env.TRAVELCANARY_RUNTIME !== "local") throw new Error("Local runtime is not enabled");
  if (!localDatabase) {
    localDatabase = new LocalDatabase();
    initializeLocalRuntime(localDatabase);
  }
  return localDatabase;
}
