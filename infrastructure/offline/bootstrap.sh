#!/bin/sh
set -eu
umask 077
bundle_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$bundle_dir"
command=${1:-verify}
case "$command" in
  verify|load|configure) ;;
  *) echo 'Expected verify, load or configure' >&2; exit 2 ;;
esac
# Integrity requires a trusted manifest/checksum obtained through a separate channel.
if [ -n "$(find . -type l -print -quit)" ]; then
  echo 'Bundle symlinks are forbidden' >&2; exit 2
fi
expected=$(mktemp)
actual=$(mktemp)
trap 'rm -f -- "$expected" "$actual"' 0
sed -n 's/^[0-9a-f]\{64\}  //p' SHA256SUMS > "$expected"
printf '%s\n' SHA256SUMS >> "$expected"
LC_ALL=C sort -o "$expected" "$expected"
find . -type f -printf '%P\n' | LC_ALL=C sort > "$actual"
if ! cmp -s "$expected" "$actual"; then
  echo 'Unexpected bundle content or checksum inventory mismatch' >&2; exit 2
fi
sha256sum --check --strict SHA256SUMS
read -r bootstrap_image < bootstrap-image.id
digest=${bootstrap_image#sha256:}
if [ "$digest" = "$bootstrap_image" ] || [ "${#digest}" -ne 64 ]; then exit 2; fi
case "$digest" in *[!0-9a-f]*) exit 2;; esac
if [ "$command" = load ]; then
  docker image load --input images.tar
  test "$(docker image inspect --format '{{.Id}}' "$bootstrap_image")" = "$bootstrap_image"
elif [ "$command" = configure ]; then
  shift
  target=${1:?Specify a NEW absolute installation directory}
  shift
  case "$target" in /*) ;; *) echo 'Installation path must be absolute' >&2; exit 2;; esac
  case "$target" in *,*) echo 'Commas in mount paths are unsupported' >&2; exit 2;; esac
  case "$bundle_dir" in *,*) echo 'Commas in mount paths are unsupported' >&2; exit 2;; esac
  parent=$(dirname -- "$target")
  name=$(basename -- "$target")
  mkdir -p -- "$parent"
  docker_gid=$(stat -c '%g' /var/run/docker.sock)
  docker run --rm --pull=never --network none --user "$(id -u):$(id -g)" \
    --mount "type=bind,source=$bundle_dir,target=/bundle,readonly" \
    --mount "type=bind,source=$parent,target=/installations" \
    "$bootstrap_image" node /bundle/scripts/offline-bundle.mjs configure \
    --directory /bundle --installation "/installations/$name" --docker-gid "$docker_gid" "$@"
fi
