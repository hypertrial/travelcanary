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

Install Node 24.19 and npm 11.6, then run:

```bash
npm ci
npm run build
bin/travelcanary setup --runtime native --port 3000
systemctl --user status travelcanary-web travelcanary-collector
```

Generated user units use the same three storage roots under `${XDG_DATA_HOME:-$HOME/.local/share}/travelcanary`, restrict the web service to read-only public data, and grant writes only to the collector. The web and collector use separate mode-0600 environment files so provider credentials added to the collector environment are never inherited by the web process. Templates are also available under `deploy/systemd/`.

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
