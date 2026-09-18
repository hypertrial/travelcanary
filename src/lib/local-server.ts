import { FilePublicationStore } from "./publication-store";
import { publicRuntimeRoot } from "./runtime-paths";

let publicationStore: FilePublicationStore | undefined;

/** The web process receives only the read-only public directory. */
export function getLocalPublicationStore() {
  if (process.env.TRAVELCANARY_RUNTIME !== "local") throw new Error("Local runtime is not enabled");
  publicationStore ??= new FilePublicationStore(publicRuntimeRoot(), false);
  return publicationStore;
}
