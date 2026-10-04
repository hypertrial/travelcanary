# Self-hosting TravelCanary

TravelCanary supports Docker on any Docker-capable host and native Node 24/systemd on Linux. Native Windows is supported through Docker.

## Docker Compose

```bash
docker compose up --build -d web collector
docker compose ps
curl --fail http://127.0.0.1:3000/api/healthz
```

Compose builds one image and runs separate roles:

- `web`: read-only root filesystem, read-only `public/` volume, no private state or credentials
- `collector`: read-only root filesystem with writable `private/`, `public/`, and `cache/` volumes
- `collector-once`: opt-in `tools` profile for one bounded pass

All roles run non-root, drop Linux capabilities, set `no-new-privileges`, and use a separate temporary filesystem. The host binds only `127.0.0.1:3000` by default.

## Native Linux

Native service isolation requires administrator-managed system services with two
different operating-system identities. Do not run the web and collector as
services of the same login account: filesystem masks do not prevent one
same-UID process from inspecting another through `/proc` or the user service
manager.

Install Node 24.19 and npm 11.6, check out the repository at a path readable by
both service accounts (for example `/opt/travelcanary`), and build it:

```bash
npm ci
npm run build
```

Create the system users and shared public-data group, then create the three
storage roots. The public root must be setgid so collector-created objects keep
the read-only group used by the web service:

```bash
sudo groupadd --system travelcanary-public
sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid travelcanary-public travelcanary-web
sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid travelcanary-public travelcanary-collector
sudo install -d -o travelcanary-collector -g travelcanary-public -m 0700 /var/lib/travelcanary/private /var/lib/travelcanary/cache
sudo install -d -o travelcanary-collector -g travelcanary-public -m 2750 /var/lib/travelcanary/public
```

Create separate environment files under `/etc/travelcanary`: the web file
contains only `TRAVELCANARY_RUNTIME=local` and
`TRAVELCANARY_PUBLIC_DATA_DIR=/var/lib/travelcanary/public`; the collector file
also contains the private/cache roots and any provider credentials. Make each
file mode `0600` and owned by its corresponding service account.

Render the placeholders in `deploy/systemd/travelcanary-*.service`, install the
units under `/etc/systemd/system`, and enable the web and collector with the
system manager. The templates enforce distinct users, a read-only public mount
for web, inaccessible private/cache/collector configuration for web, and
collector-only writes. The CLI intentionally does not automate this privileged
account setup; use Docker for a one-command isolated installation.

## Data and recovery

The private SQLite database contains collector state only. Public payloads are immutable files under `public/` and become visible through one pointer. Keep the three roots on a local filesystem; do not use NFS, SMB, or cloud-synchronized directories.

```bash
bin/travelcanary backup /secure/path/travelcanary.db
bin/travelcanary restore /secure/path/travelcanary.db
```

Backups are private and mode `0600`. Restoring private state does not mutate an already published generation. After V16 migration, never restore V15 or run an older collector. Public rollback means repointing to the preceding valid Catalog 3 manifest while ingestion is paused.

Docker restore stops web and collector, forwards the binary backup to the inner
restore, and attempts to restart the services after either success or failure.
For native services, stop `travelcanary-collector.service` before restoring and
run the CLI as the collector account with its private storage environment. An
active collector lease causes restore to refuse without replacing state; an
expired lease does not prove that the collector process has stopped. Restart
the collector after the command completes.

Restore validates the V16 backup first, preserves the current database as a
mode-`0600` `travelcanary.db.pre-restore-<timestamp>` backup, and replaces private
objects in one SQLite transaction while keeping the database file in place.
Failure rolls back the replacement. Restored objects receive fresh target
revisions; collector leases from the backup are discarded.

### Recovering a corrupt private database

Use this opt-in mode only after stopping every process that uses the private
database. Native operators must stop both collector services, any one-shot
jobs, and other CLI operations, then run as the collector account:

```bash
bin/travelcanary restore /secure/path/backup.db --recover-corrupt --collector-stopped
```

For a managed Docker installation, omit `--collector-stopped`: the launcher
stops web, collector, collector-once and all containers mounting its private
volume, including one-off and unlabeled containers, and verifies shutdown
before forwarding the backup. Keep other operators from starting containers
or native writers until recovery finishes. This mode requires Docker Compose
with JSON configuration output. Successful recovery starts only the regular
web and collector; any recovery failure leaves services stopped.

Only confirmed SQLite corruption qualifies. Permission, I/O, locking, missing
target, incompatible schema and invalid-state errors never authorize file
replacement. A healthy supported target uses normal transactional restore,
including its active collector lease check. The backup must pass full V16,
Catalog 3, policy and private-object validation before recovery begins. SQLite
validation uses `integrity_check`, including index/table consistency and
uniqueness checks; the faster `quick_check` is insufficient for recovery.

Recovery preserves the original database, WAL and SHM bytes in a private
`travelcanary.db.recovery/originals/` directory, diagnoses a disposable copy,
and builds a fresh validated database without importing backup triggers or
SQLite collector-table leases. Embedded V16 ingestion and conditions leases
retain their existing restore semantics and may delay collection until expiry.
The staged database is checkpointed and installed without overwriting an
unexpected target. A successful operation retains a mode-`0700`
`travelcanary.db.pre-recovery-<uuid>` archive with mode-`0600` files. Archives
are private operator evidence; do not publish or automatically prune them.

### Interrupted corruption recovery

A pending `travelcanary.db.recovery` directory blocks collector, policy,
backup and restore operations before opening SQLite. Do not delete it based
on its age or PID. Stop all writers and confirm that the original restore
process has exited. Preserve an additional private copy of the entire pending
directory before manual resolution. Missing/invalid manifests or unknown files
require investigation with services stopped.

The following manual procedure verifies recorded hashes before changing files.
Set `RECOVERY_OUTCOME=complete` to finish the validated staged installation, or
`RECOVERY_OUTCOME=rollback` to restore the recorded original file set. Rollback
returns the original corrupt database; afterward rerun the backup restore while
writers remain stopped. Neither outcome starts services. Run as the collector
account with `RECOVERY_DIR` set to the absolute pending directory; for Docker,
run the same Node input in a `docker compose run --rm --no-deps -T collector`
container, supplying those two environment variables and `/data/private/` as
the private root. Never invoke the collector command for this manual step.

```bash
RECOVERY_DIR=/var/lib/travelcanary/private/travelcanary.db.recovery \
RECOVERY_OUTCOME=complete node --input-type=module <<'JS'
// manual-private-recovery
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, copyFileSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
const guard = resolve(process.env.RECOVERY_DIR);
assert(guard.endsWith('/travelcanary.db.recovery'));
assert(lstatSync(guard).isDirectory() && !lstatSync(guard).isSymbolicLink());
const target = guard.slice(0, -'.recovery'.length);
const manifest = JSON.parse(readFileSync(join(guard, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, 1); assert.equal(manifest.target, basename(target));
const suffixes = ['', '-wal', '-shm'];
assert(Array.isArray(manifest.files) && manifest.files.length <= 3);
assert.equal(new Set(manifest.files.map(f => f.suffix)).size, manifest.files.length);
assert(manifest.files.some(f => f.suffix === ''));
for (const f of manifest.files) assert(suffixes.includes(f.suffix) && /^[a-f0-9]{64}$/.test(f.sha256));
const restored = manifest.restored ?? [];
assert(Array.isArray(restored) && restored.length <= 3);
assert.equal(new Set(restored.map(f => f.suffix)).size, restored.length);
for (const f of restored) assert(manifest.files.some(original => original.suffix === f.suffix && original.sha256 === f.sha256));
const present = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const hash = path => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { assert(lstatSync(path).isFile()); return createHash('sha256').update(readFileSync(fd)).digest('hex'); }
  finally { closeSync(fd); }
};
const flush = path => { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } };
const stage = join(guard, 'staged.db');
const isStage = path => {
  if (!present(path) || !manifest.staged) return false;
  const stat = lstatSync(path);
  return stat.dev === manifest.staged.dev && stat.ino === manifest.staged.ino && hash(path) === manifest.staged.sha256;
};
// Validate all source evidence and destination identities before changing any file.
for (const f of manifest.files) assert.equal(hash(join(guard, 'originals', basename(target) + f.suffix)), f.sha256);
for (const f of restored) {
  const alias = join(guard, 'rollback' + f.suffix + '.db'); const stat = present(alias);
  if (stat) assert(stat.dev === f.dev && stat.ino === f.ino && hash(alias) === f.sha256, 'Unknown rollback alias');
}
for (const suffix of suffixes) {
  const path = target + suffix; const stat = present(path);
  if (!stat) continue;
  const f = manifest.files.find(f => f.suffix === suffix);
  const replacement = restored.find(f => f.suffix === suffix);
  assert((f && stat.dev === f.dev && stat.ino === f.ino && hash(path) === f.sha256) ||
    (replacement && stat.dev === replacement.dev && stat.ino === replacement.ino && hash(path) === replacement.sha256) ||
    (suffix === '' && isStage(path)), 'Unknown target file; investigate without overwriting');
}
if (process.env.RECOVERY_OUTCOME === 'complete') {
  assert(manifest.staged && /^[a-f0-9]{64}$/.test(manifest.staged.sha256));
  assert(isStage(stage) || isStage(target), 'Validated stage unavailable; use rollback');
  for (const suffix of suffixes) if (present(target + suffix) && !(suffix === '' && isStage(target))) unlinkSync(target + suffix);
  if (!present(target)) linkSync(stage, target);
  assert(isStage(target)); if (present(stage)) unlinkSync(stage); flush(target);
} else {
  assert.equal(process.env.RECOVERY_OUTCOME, 'rollback');
  for (const suffix of suffixes) {
    const path = target + suffix; const f = manifest.files.find(f => f.suffix === suffix);
    if (present(path) && !f) { assert(suffix === '' && isStage(path)); unlinkSync(path); }
    else if (present(path) && isStage(path)) unlinkSync(path);
    if (f && !present(path)) { copyFileSync(join(guard, 'originals', basename(target) + suffix), path, constants.COPYFILE_EXCL); flush(path); }
    if (f) assert.equal(hash(path), f.sha256); else assert(!present(path));
  }
}
// Interrupted rollback may leave its private installation link. Remove only
// aliases whose identity was durably recorded by this operation.
for (const f of restored) {
  const alias = join(guard, 'rollback' + f.suffix + '.db'); const stat = present(alias);
  if (!stat) continue;
  assert(stat.dev === f.dev && stat.ino === f.ino && hash(alias) === f.sha256, 'Unknown rollback alias');
  unlinkSync(alias);
}
for (const suffix of suffixes) if (present(target + suffix)) assert.equal(lstatSync(target + suffix).nlink, 1, 'Unidentified target hardlink');
flush(guard); flush(dirname(target));
renameSync(guard, target + '.pre-recovery-' + randomUUID()); flush(dirname(target));
console.log('Manual recovery verified; private archive retained. Services remain stopped.');
JS
```

Do not automatically retry a failed manual procedure. Preserve the guard and
files, inspect the reported invariant, and investigate. After successful
completion, restart only regular web/collector services. Never restore V15,
clear embedded leases, or mutate public publications as part of private recovery.

## Source policy

Open reviewed sources run by default. Restricted sources require explicit acceptance of the current data-policy manifest:

```bash
bin/travelcanary policy accept-restricted
bin/travelcanary policy disable-restricted
```

Gated sources remain unable to make requests. Optional warning credentials are not required.

## Public exposure

For LAN use, deliberately change the bind address and firewall the host. For internet use, add a maintained TLS reverse proxy and your own access controls. Never expose the private directory, collector environment, or authenticated cron routes.
