#!/bin/sh
set -eu

version=$1
requested_port=$2
variant=${3:-production}

case "$variant" in
  production) name=cbranch ;;
  canary) name=cbranch-canary ;;
  *) printf '%s\n' 'Invalid cbranch server variant.' >&2; exit 1 ;;
esac

case "$version" in
  '' | *[!0-9A-Za-z._-]*)
    printf '%s\n' 'Invalid cbranch server version.' >&2
    exit 1
    ;;
esac

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  printf '%s\n' 'Managed setup currently supports Linux x86_64 remote hosts.' >&2
  exit 1
fi

node_bin=$(command -v node || true)
if [ -z "$node_bin" ] && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # SSH runs a non-interactive shell, which does not load the user's shell profile.
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  node_bin=$(command -v node || true)
fi
if [ -z "$node_bin" ]; then
  printf '%s\n' 'Managed setup requires Node.js 20 or newer on the remote host.' >&2
  exit 1
fi

if ! "$node_bin" -e 'const [major] = process.versions.node.split("."); process.exit(Number(major) >= 20 ? 0 : 1)'; then
  printf '%s\n' 'Managed setup requires Node.js 20 or newer on the remote host.' >&2
  exit 1
fi

uid=$(id -u)
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$uid}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if ! systemctl --user show-environment >/dev/null 2>&1; then
  printf '%s\n' 'Managed setup requires an active systemd user service manager on the remote host.' >&2
  exit 1
fi
systemctl --user stop "$name.service" >/dev/null 2>&1 || true

port=$("$node_bin" -e '
const net = require("node:net");
const requested = Number(process.argv[1]);
if (!Number.isInteger(requested) || requested < 1 || requested > 65535)
  process.exit(1);
const reserve = port =>
  new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(undefined));
    server.listen({ host: "127.0.0.1", port }, () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" ? address.port : undefined));
    });
  });
(async () => {
  const selected = (await reserve(requested)) ?? (await reserve(0));
  if (selected === undefined) process.exit(1);
  process.stdout.write(String(selected));
})().catch(() => process.exit(1));
' "$requested_port") || {
  printf '%s\n' 'Could not allocate a loopback port for cbranch.' >&2
  exit 1
}

data_root="${XDG_DATA_HOME:-$HOME/.local/share}/$name"
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/$name"
source_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
release_dir="$data_root/releases/$version"
next_dir="$release_dir.next"
current_dir="$data_root/current"

mkdir -p "$data_root/releases" "$config_root" "$HOME/.config/systemd/user"
if ! "$node_bin" -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.exit(manifest.version === process.argv[2] ? 0 : 1);
' "$source_dir/cbranch-server.json" "$version"; then
  printf '%s\n' 'The managed server bundle does not match this desktop version.' >&2
  exit 1
fi
rm -rf "$next_dir"
mv "$source_dir" "$next_dir"
rm -rf "$release_dir"
mv "$next_dir" "$release_dir"
ln -sfn "$release_dir" "$current_dir"

unit="$HOME/.config/systemd/user/$name.service"
cat > "$unit" <<EOF
[Unit]
Description=$name server

[Service]
Type=simple
WorkingDirectory=$current_dir
Environment=CBRANCH_BIND_ADDRESS=127.0.0.1
Environment=CBRANCH_PORT=$port
Environment=CBRANCH_CONFIG=$config_root/config.json
Environment=CBRANCH_RELEASE_VERSION=$version
Environment=XDG_DATA_HOME=$data_root/data
Environment=XDG_CONFIG_HOME=$config_root
ExecStart="$node_bin" "$current_dir/dist/main.js"
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

if ! systemctl --user daemon-reload || \
  ! systemctl --user enable "$name.service" || \
  ! systemctl --user restart "$name.service"; then
  printf '%s\n' "Could not start the $name systemd user service." >&2
  exit 1
fi

attempt=0
until "$node_bin" -e '
const http = require("node:http");
const port = Number(process.argv[1]);
const request = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 500 }, response => {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", chunk => { body += chunk; });
    response.on("end", () => {
      try {
        const health = JSON.parse(body);
        process.exit(response.statusCode === 200 && health.service === "cbranch" && health.version === process.argv[2] ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
});
request.on("error", () => process.exit(1));
request.on("timeout", () => request.destroy());
 ' "$port" "$version"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 20 ]; then
    printf '%s\n' "The $name service did not become ready. Inspect it with systemctl --user status $name.service." >&2
    exit 1
  fi
  sleep 0.5
done

linger=unknown
if command -v loginctl >/dev/null 2>&1; then
  linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || printf '%s' unknown)
fi

printf 'CBRANCH_SETUP_PORT=%s\n' "$port"
printf 'CBRANCH_SETUP_LINGER=%s\n' "$linger"
