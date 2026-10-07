# Shared browser service

One ephemeral Chromium context per Make Together browser panel. Every participant connects to the same context and receives JPEG frames over WebSocket. Clicks, scrolling, navigation, keyboard input and history affect that one page. Each context has separate cookies and storage. A reconnect within two minutes restores the existing page; an idle session is destroyed after two minutes and every session expires after one hour.

The Netlify app stays on Netlify. This service needs a separate Linux server with Docker Compose and HTTPS/WebSocket termination. It cannot run as a Netlify Function. The accompanying Netlify function only issues signed two-minute connection tickets.

## Deploy

1. Use a dedicated Linux host that supports Chromium's user-namespace sandbox. Install Docker Engine and Compose. Allow at least 4 GB RAM for the initial four-session cap; actual consumption depends on the pages loaded.
2. Copy `.env.example` to `.env`. Generate the signing key with `openssl rand -hex 32`; use that same private value in Netlify's `BROWSER_SIGNING_KEY`. Do not put this key in a `VITE_` variable or commit it.
3. Set `ALLOWED_ORIGINS` to the exact app origin, normally `https://maketogether.dev`. Add preview origins explicitly only when needed; there are no wildcard origins.
4. Run `docker compose up --build -d`. Chromium runs as a non-root user with its sandbox enabled. The checked-in seccomp profile is from Playwright v1.63.0 (Apache-2.0; see LICENSE.playwright): https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json . The image installs the browser revision matching the pinned npm package rather than relying on a separately published Playwright image.
5. Put an HTTPS reverse proxy on the host in front of `127.0.0.1:8080`. Forward `/browser` with WebSocket upgrades; `/health` returns `ok`. Use an idle timeout over 60 seconds. For example, a Caddy host configuration is:

   ```caddy
   browser.example.com {
     reverse_proxy 127.0.0.1:8080
   }
   ```

6. Set Netlify runtime variables `BROWSER_SERVICE_URL=wss://browser.example.com/browser` and `BROWSER_SIGNING_KEY` to the same signing key. Netlify discovers `netlify/functions/browser-session.mjs` automatically. Requests to the ticket function are rate limited; signing keys never reach the client.
7. Check `/health`, then test a preview build with `VITE_SHARED_BROWSER_ENABLED=true`. Verify two devices can navigate, click, type, scroll and reconnect, and that loading a private/local address is rejected. Only then enable that build variable for production and redeploy.

Do not expose the egress proxy or attach the browser container to an internet-enabled Docker network. The browser container has only an internal network; the proxy resolves and pins public IP addresses, rejecting private, loopback, link-local, multicast and other special ranges. This also applies after redirects. Only HTTP port 80 and HTTPS port 443 are supported. Chromium's direct WebRTC traffic is disabled.

The service intentionally permits anonymous sessions via the Netlify ticket issuer, matching Make Together's guest rooms. A high-entropy panel UUID and room name determine the session capability. Anyone with access to that room/panel can control the page and see its contents. Initial capacity is four sessions, eight connections per session; input queues and message sizes are bounded. Add account-level authorization before offering private authenticated workspaces.

## Validation

```sh
npm ci
npm test
```

Tests launch local Chromium and a fixture website, exercising two-client control, frame delivery, navigation, history, reconnects, authentication, session isolation, idle cleanup and public-egress address validation. Repository `npm run test:browser` additionally uses the actual app in desktop and iPhone WebKit clients against this service. Install this directory's dependencies before running that suite.

Docker is not required for these local tests; fixture tests intentionally use a local website without the production egress proxy. A deployment smoke test must additionally verify the Compose network and Linux sandbox; do not disable the sandbox to make a failing host work.

## Current boundaries

This is a shared visual browser, not an audio/video streaming replacement. Browser audio, uploads/downloads, multiple tabs, drag-and-drop and native browser dialogs are not exposed. New windows are opened in the shared page when possible. Use Make Together's YouTube and DAW panels for synchronized media. Sites that reject automated browsers, require hardware authentication or require DRM may not work. Sessions and credentials are discarded at expiry; they are never exported in room bundles. The saved room only retains the last public page address.
