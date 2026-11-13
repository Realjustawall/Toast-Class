# Linux browser test environment

Status: the image built and all five media specs passed in the Linux container, including normal browser cleanup. This does not certify production deployment. The official image currently supplies Node 26.13.0; Windows development uses Node 24.11.0.

The [official Playwright image](https://playwright.dev/docs/docker) includes the matching browser binaries and OS dependencies. It provides an alternative when the browser download CDN is unavailable from a workstation. The tag in `infrastructure/docker/Dockerfile.tests` must match the locked Playwright version. The image is for our trusted local test application, not a production document renderer.

Install Docker Engine using its [Ubuntu repository instructions](https://docs.docker.com/engine/install/ubuntu/). In this workspace, Engine 29.9.3 and Compose 5.7.0 are installed in Ubuntu 24.04 WSL. Its older 5.10 kernel failed the normal Docker bridge/NAT startup. The task-owned test daemon instead runs with `--iptables=false --ip6tables=false --bridge=none --ip-masq=false`; containers below use Linux host networking. This environment-specific setup is not a production networking recommendation or a clean Compose verification.

Use an existing PostgreSQL test database with a name ending in `_test`. Each test server creates an isolated schema. Generate the test-only configuration before starting its SFU:

```sh
export TEST_DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/toaster_test'
export TEST_MEDIA_NODE_IP='YOUR_REACHABLE_LINUX_IPV4'
npx tsx scripts/prepare-local-media.ts
livekit-server --config .local/livekit-linux.yaml
```

The generator stores random credentials only in ignored `.local` files. A matching existing configuration is reused. Stop the matching SFU before using `--rotate`, including after an IP/database change. The local test SFU uses private signaling port 17880, RTC TCP 17881 and UDP 52000–52100, with signed callbacks to the test API on port 33001. It is separate from the native Windows-oriented SFU on 7880.

Build and run from the project root in another shell:

```sh
docker build --network=host -f infrastructure/docker/Dockerfile.tests -t toaster-tests .
mkdir -p test-results docs/screenshots
docker run --rm --init --network=host --ipc=host \
  --env-file .local/linux-test.env \
  --mount type=bind,source="$(pwd)/test-results",target=/work/test-results \
  --mount type=bind,source="$(pwd)/docs/screenshots",target=/work/docs/screenshots \
  toaster-tests
```

Do not set `PW_CHANNEL=chrome` in this container; it uses the bundled Chromium. The runner discovers every media spec and recreates API/Vite infrastructure per file. Passing `npm run test:e2e` as the container command runs ordinary browser workflows instead. Inspect and record the actual container Node/browser versions and results before claiming verification.

Media fixtures use native `getUserMedia` with generated test video and Chromium fake audio over real WebRTC/SFU connections. The file camera is 320×180 at 10 fps. A separate test retains the ordinary fake-camera acquisition/reload path; the display-capture workflow has its own browser-tab source flags. These test inputs do not prove physical device or GPU behavior. The independent-browser fixture records its own browser servers and tears down only those processes. A cleanup failure still fails the test; successful classroom assertions do not conceal it.

## Native MySQL and disconnected runtime gates

Set TEST_DATABASE_ENGINE=mysql and TEST_MYSQL_ADMIN_URL to a dedicated administration database ending in _test. Each suite creates only its own generated database. Use TEST_MYSQL_RECOVERY_DOCKER=true for the real cached-client dump/restore drill; this requires a trusted Linux Docker host and a locally present MySQL client image. Test administration credentials must never be used for the deployed application.

TEST_WEB_BUILD=true makes browser fixtures build/serve actual production assets with the same authorized API proxy, avoiding Vite development HMR during reconnect/reload scenarios. API and SFU callbacks must use the same TEST_API_PORT (default33001); run media scenarios sequentially and do not overlap callback endpoints with another isolated fixture. The native offline namespace evidence and remaining installation gaps are documented in OFFLINE.md. Current task-specific ignored credentials/IPs are not reusable installation defaults.
