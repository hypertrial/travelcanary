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

## Source policy

Open reviewed sources run by default. Restricted sources require explicit acceptance of the current data-policy manifest:

```bash
bin/travelcanary policy accept-restricted
bin/travelcanary policy disable-restricted
```

Gated sources remain unable to make requests. Optional warning credentials are not required.

## Public exposure

For LAN use, deliberately change the bind address and firewall the host. For internet use, add a maintained TLS reverse proxy and your own access controls. Never expose the private directory, collector environment, or authenticated cron routes.
