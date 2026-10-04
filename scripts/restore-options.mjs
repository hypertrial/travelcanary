export function parseRestoreArgs(args) {
  const [input, ...flags] = args;
  if (!input || (input.startsWith("--")) || flags.some((flag) => !["--recover-corrupt", "--collector-stopped"].includes(flag)) || new Set(flags).size !== flags.length) {
    throw new Error("Usage: travelcanary restore <backup> [--recover-corrupt [--collector-stopped]]");
  }
  const recover = flags.includes("--recover-corrupt");
  const stopped = flags.includes("--collector-stopped");
  if (stopped && !recover) throw new Error("--collector-stopped requires --recover-corrupt");
  return { input, recover, stopped };
}

// Recovery needs proof that even one-off writers in this installation have stopped.
export function stopRecoveryWriters(compose, docker) {
  const configuration = JSON.parse(compose(["config", "--format", "json"], { capture: true }).toString());
  const project = configuration.name;
  const volume = configuration.volumes?.["travelcanary-private"]?.name;
  if (typeof project !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(project) || typeof volume !== "string") throw new Error("Cannot identify the Docker installation's private volume");
  compose(["--profile", "tools", "stop", "web", "collector", "collector-once"]);
  const list = () => docker(["ps", "--all", "--quiet", "--filter", `volume=${volume}`], { capture: true }).toString().trim().split(/\s+/).filter(Boolean);
  const writers = list().filter((id) => {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("Invalid Docker container identity");
    const mounts = JSON.parse(docker(["inspect", "--format", "{{json .Mounts}}", id], { capture: true }).toString());
    if (!Array.isArray(mounts)) throw new Error("Cannot inspect Docker mounts");
    return mounts.some((mount) => mount.Name === volume);
  });
  if (writers.length) docker(["stop", ...writers]);
  // A concurrent newly started container also makes recovery unsafe.
  for (const id of list()) {
    const running = docker(["inspect", "--format", "{{.State.Running}}", id], { capture: true }).toString().trim();
    if (running !== "false") throw new Error("A Docker private database container is still running; keep services stopped");
  }
}
