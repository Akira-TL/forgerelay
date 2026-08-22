#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

debug_host_port="${FORGERELAY_DEBUG_HOST_PORT:-7677}"
inspector_client_port="${MCP_INSPECTOR_CLIENT_PORT:-6274}"
inspector_sandbox_port="${MCP_INSPECTOR_SANDBOX_PORT:-6275}"
for port_value in "$debug_host_port" "$inspector_client_port" "$inspector_sandbox_port"; do
  if [[ ! "$port_value" =~ ^[0-9]+$ ]] || (( port_value < 1 || port_value > 65535 )); then
    echo "[forgerelay:debug-host] debug/Inspector ports must be integers from 1 to 65535." >&2
    exit 1
  fi
done

health_url="http://127.0.0.1:${debug_host_port}/healthz"
mcp_url="http://127.0.0.1:${debug_host_port}/mcp"
inspector_url="http://127.0.0.1:${inspector_client_port}"
inspector_package="${MCP_INSPECTOR_PACKAGE:-@modelcontextprotocol/inspector@2.3.0}"
inspector_node_dir="${MCP_INSPECTOR_NODE_DIR:-}"

if [[ -z "$inspector_node_dir" ]]; then
  current_node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if (( current_node_major >= 25 )) && [[ -d "$HOME/.nvm/versions/node" ]]; then
    inspector_node_dir="$(find "$HOME/.nvm/versions/node" -mindepth 1 -maxdepth 1 -type d -name 'v24.*' -printf '%p\n' 2>/dev/null | sort -V | tail -n 1)/bin"
    if [[ "$inspector_node_dir" == "/bin" || ! -x "$inspector_node_dir/node" || ! -x "$inspector_node_dir/npx" ]]; then
      inspector_node_dir=""
    fi
  fi
fi

inspector_path="$PATH"
if [[ -n "$inspector_node_dir" ]]; then
  if [[ ! -x "$inspector_node_dir/node" || ! -x "$inspector_node_dir/npx" ]]; then
    echo "[forgerelay:debug-host] MCP_INSPECTOR_NODE_DIR must contain executable node and npx binaries." >&2
    exit 1
  fi
  inspector_path="$inspector_node_dir:$PATH"
fi

if ! PATH="$inspector_path" command -v npx >/dev/null 2>&1; then
  echo "[forgerelay:debug-host] npx is required to launch MCP Inspector." >&2
  exit 1
fi

port_in_use() {
  ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .
}

if port_in_use "$debug_host_port"; then
  cat >&2 <<EOF
[forgerelay:debug-host] port ${debug_host_port} is already in use.
[forgerelay:debug-host] refusing to replace or reuse that process because its publicBaseUrl/widgets may not match local Host mode.
[forgerelay:debug-host] stop it, or temporarily set FORGERELAY_DEBUG_HOST_PORT to another loopback port.
EOF
  exit 1
fi

for inspector_port in "$inspector_client_port" "$inspector_sandbox_port"; do
  if port_in_use "$inspector_port"; then
    echo "[forgerelay:debug-host] Inspector port ${inspector_port} is already in use; refusing to replace that process." >&2
    exit 1
  fi
done

log_dir="$repo_root/logs"
server_log="$log_dir/debug-host-server.log"
inspector_log="$log_dir/debug-host-inspector.log"
mkdir -p "$log_dir"
: >"$server_log"
: >"$inspector_log"

server_pid=""
inspector_pid=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$inspector_pid" ]] && kill -0 "$inspector_pid" >/dev/null 2>&1; then
    kill "$inspector_pid" >/dev/null 2>&1 || true
    wait "$inspector_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" >/dev/null 2>&1; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

FORGERELAY_DEBUG_HOST_PORT="$debug_host_port" \
  node scripts/debug/host/serve.mjs > >(tee -a "$server_log") 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 120); do
  if curl --silent --fail --max-time 1 "$health_url" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    echo "[forgerelay:debug-host] ForgeRelay debug server exited before becoming ready." >&2
    echo "[forgerelay:debug-host] see $server_log" >&2
    exit 1
  fi
  sleep 0.25
done

if [[ "$ready" != "1" ]]; then
  echo "[forgerelay:debug-host] ForgeRelay debug server did not become ready on ${debug_host_port}." >&2
  echo "[forgerelay:debug-host] see $server_log" >&2
  exit 1
fi

inspector_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"

echo "[forgerelay:debug-host] ForgeRelay ready: $mcp_url"
echo "[forgerelay:debug-host] launching MCP Inspector Web Host via $inspector_package"
if [[ -n "$inspector_node_dir" ]]; then
  inspector_node_version="$(PATH="$inspector_path" node --version)"
  echo "[forgerelay:debug-host] Inspector compatibility runtime: $inspector_node_version ($inspector_node_dir)"
fi
echo "[forgerelay:debug-host] complete OAuth with the persisted debug Owner password when prompted."
echo "[forgerelay:debug-host] logs: $server_log and $inspector_log (Inspector tokens are redacted from the log)"

HOST=127.0.0.1 \
CLIENT_PORT="$inspector_client_port" \
MCP_SANDBOX_PORT="$inspector_sandbox_port" \
MCP_AUTO_OPEN_ENABLED=false \
MCP_INSPECTOR_API_TOKEN="$inspector_token" \
PATH="$inspector_path" \
  npx -y "$inspector_package" --web --server-url "$mcp_url" --transport http \
  > >(tee >(sed -E \
      -e 's/(MCP_INSPECTOR_API_TOKEN=)[[:alnum:]]+/\1<redacted>/g' \
      -e 's/(Auth token: )[[:alnum:]]+/\1<redacted>/g' \
      >"$inspector_log")) 2>&1 &
inspector_pid=$!

inspector_ready=0
for _ in $(seq 1 160); do
  if curl --silent --fail --max-time 1 "$inspector_url/" >/dev/null 2>&1; then
    inspector_ready=1
    break
  fi
  if ! kill -0 "$inspector_pid" >/dev/null 2>&1; then
    echo "[forgerelay:debug-host] MCP Inspector exited before becoming ready." >&2
    echo "[forgerelay:debug-host] see $inspector_log" >&2
    wait "$inspector_pid" || true
    exit 1
  fi
  sleep 0.25
done

if [[ "$inspector_ready" != "1" ]]; then
  echo "[forgerelay:debug-host] MCP Inspector did not become ready on ${inspector_client_port}." >&2
  echo "[forgerelay:debug-host] see $inspector_log" >&2
  exit 1
fi

encoded_mcp_url="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$mcp_url")"
deep_link="${inspector_url}/?serverUrl=${encoded_mcp_url}&transport=http&autoConnect=${inspector_token}"

echo "[forgerelay:debug-host] Inspector ready: $inspector_url"
echo "[forgerelay:debug-host] MCP Apps sandbox: http://127.0.0.1:${inspector_sandbox_port}/sandbox"
echo "[forgerelay:debug-host] open this one-shot local Host link:"
echo "$deep_link"

if [[ "${MCP_INSPECTOR_AUTO_OPEN:-1}" == "1" ]]; then
  if command -v wslview >/dev/null 2>&1; then
    wslview "$deep_link" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$deep_link" >/dev/null 2>&1 || true
  fi
fi

set +e
wait "$inspector_pid"
inspector_status=$?
set -e
exit "$inspector_status"
