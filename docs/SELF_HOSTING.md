# Self-hosting TravelCanary

TravelCanary supports one host, one web process, and one collector. It stores one private `travelcanary.db` using SQLite WAL mode. Network filesystems, clustered replicas, and multiple collectors are unsupported.

## Docker Compose

Install Docker with Compose, then run:

```bash
bin/travelcanary setup --runtime docker --port 3000
bin/travelcanary status
```

The setup builds one image, starts separate web and collector services, shares a named data volume, and publishes only `127.0.0.1:3000`. The initial catalog contains all 679 destinations as `UNKNOWN`; live states replace them as reviewed sources complete.

## Native Node and systemd

On Linux, install Node 24.19.0 and npm 11.6.2 yourself. TravelCanary never installs system packages or uses root access. From a persistent repository checkout:

```bash
bin/travelcanary setup --runtime native --port 3000
bin/travelcanary status
```

Setup runs `npm ci`, builds the app, initializes the database under `${XDG_DATA_HOME:-$HOME/.local/share}/travelcanary`, and writes user services under `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`. Both services bind or connect locally; inspect them with `systemctl --user status travelcanary-web travelcanary-collector`.

## Restricted data

Open reviewed sources collect by default. Six reviewed sources have noncommercial terms and remain disabled until the operator reads `docs/DATA_POLICY.md`, `THIRD_PARTY_NOTICES.md`, and accepts the current manifest:

```bash
bin/travelcanary policy accept-restricted
bin/travelcanary policy disable-restricted
```

Acceptance records the exact manifest digest and timestamp. Any manifest change disables restricted sources until they are accepted again. The web UI and Omarchy panel disclose when restricted sources are active. Gated and blocked sources remain unable to make requests.

Disabling acceptance stops new restricted collection immediately. If a previously published conditions generation still contains restricted-source data, the disclosure remains visible until the collector publishes the next conditions generation without it.

## Backup and restore

```bash
bin/travelcanary backup
bin/travelcanary backup /secure/path/travelcanary.db
bin/travelcanary restore /secure/path/travelcanary.db
```

Backups contain private ingestion state and are created with mode `0600`. Restore stops managed services, preserves the replaced database beside the live file with a `pre-restore` timestamp, validates the backup, and restarts the services.

## LAN or public access

The supported default is loopback only. For deliberate LAN access, change the web bind address in `compose.yaml` or the generated user unit and firewall the host. For any public exposure, place an authenticated, maintained TLS reverse proxy in front of TravelCanary and keep the collector and SQLite volume private. There is no writable web-admin surface.
