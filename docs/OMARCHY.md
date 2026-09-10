# Omarchy plugin

TravelCanary is an Omarchy shell plugin with a headless service and one bar widget. It reads only the bounded local summary endpoint. It does not install packages, elevate privileges, start services, read secrets, or send notifications.

Start TravelCanary first, then add the public repository and enable the widget:

```bash
bin/travelcanary setup --runtime docker --port 3000
omarchy plugin add https://github.com/hypertrial/travelcanary.git --enable
```

Native instances use the same widget after `bin/travelcanary setup --runtime native --port 3000`. The default URL is `http://127.0.0.1:3000`; settings accept only loopback HTTP origins. Polling defaults to five minutes and is clamped to 60–3600 seconds.

The bar shows the canary mark, strongest current state, and attention count. Click for service health, update time, counts, the restricted-source disclosure, and up to ten urgent or update-delayed destinations. Select a destination to open its validated `destination` query in the local web app. Middle-click or press `R` in the panel to refresh.

If the service is unavailable, the panel shows the exact Docker and native setup commands. It never attempts to start the application itself.

Validate the tracked plugin contract with `npm run omarchy:check`. On an Omarchy machine with Qt Quick Test available, run the fake-service entrypoint test with:

```bash
OMARCHY_PATH=/path/to/omarchy omarchy/tests/run-offscreen.sh
```
