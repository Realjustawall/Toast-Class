# Real object storage contract

The contract in `tests/storage.test.ts` uses the actual S3 adapter over HTTP. It tests 300000 random bytes, a range crossing stream chunk boundaries, conditional put preventing replacement, unchanged original bytes, denied anonymous/invalid-signature reads, idempotent deletion and invalid keys. It deletes only its freshly generated UUID object and uses a bucket whose name ends in `-test`. No bucket deletion or broad object cleanup occurs.

Conditional failures must return 412, including the losing concurrent writer; invalid signatures must return 403 and deleted objects 404. A generic transport failure does not satisfy these assertions. The SDK's non-retryable streaming warnings during deliberate 412 cases are expected; successful assertions confirm the actual status codes and retained bytes.

Garage **2.5.0** was started locally following its [official quick start](https://garagehq.deuxfleurs.fr/documentation/quick-start/). The contract **failed**: a second PutObject with `If-None-Match: *` succeeded instead of rejecting replacement. TOASTER does not certify this provider/version. Its temporary container was stopped after the test. No real user data was involved. The check remains mandatory; it is not replaced by a racy HEAD-before-PUT check.

SeaweedFS **4.52** passed the actual adapter contract, including two concurrent conditional creates with exactly one winner. Tests also passed unchanged original bytes, ranges, denied anonymous/invalid-signature access and idempotent deletion. The native Linux binary was downloaded from its [official release](https://github.com/seaweedfs/seaweedfs/releases/tag/4.52) and SHA-256 matched `8b538c22d47d0c3fb6792adaa6b0c735a967401270a53427d5a476dcaca9b7ae`. Docker-image pulls encountered actual network resets/timeouts, so no SeaweedFS Docker deployment is claimed. The [conditional write](https://github.com/seaweedfs/seaweedfs/wiki/S3-Conditional-Operations) and [credential](https://github.com/seaweedfs/seaweedfs/wiki/S3-Credentials) documentation informed the configuration. These results cover required operations on one local server, not full S3, cluster durability, capacity or restore certification.

```sh
npx tsx scripts/prepare-seaweed-test.ts
docker run --rm --name toaster-seaweed-test --network host \
  --mount type=bind,source="$(pwd)/.local/seaweed-s3.json",target=/etc/seaweed-s3.json,readonly \
  chrislusf/seaweedfs:4.52 server -dir=/data -ip=127.0.0.1 -ip.bind=127.0.0.1 \
  -master.port=19333 -volume.port=18080 -filer -filer.port=18888 \
  -s3 -s3.port=18333 -s3.config=/etc/seaweed-s3.json -master.telemetry=false
```

Once the service is ready, in another project shell:

The tested native alternative uses `weed server` with the same flags and a private local data directory, pointing `-s3.config` to the generated `.local/seaweed-s3.json`. Keep all listener addresses on loopback. In PowerShell, pass the Linux command through a quoted shell script/string so dotted IP arguments arrive unchanged. The server's telemetry switch is `-master.telemetry=false`.

```sh
npx tsx scripts/prepare-seaweed-test.ts --create-bucket
TEST_S3_CONFIG=.local/seaweed-test.json npx tsx --test tests/storage.test.ts
```

PowerShell: `$env:TEST_S3_CONFIG='.local/seaweed-test.json'` before running the test command. The generator reuses existing credentials and never prints them. Run Node inside the same Linux host if localhost forwarding is unavailable. The local test key has administration rights and must not be used for a real deployment. Production keys should be restricted to the private application bucket; internal filer/master/volume/S3 endpoints must not become public bypass paths.

`prepare-local-storage.ts` and its `.local/garage-test.*` files preserve the rejected Garage experiment for reproducibility. Its data lived only in the temporary container. Do not interpret any capacity/available-space log as a TOASTER benchmark.
