#!/usr/bin/env bash
# Hand pay.agent's in-memory unlocks from the running process to the new one on
# a restart, so a deploy does not pause every pay link (src/handoff.ts).
#
#   vault-handoff.sh export   prints the handoff JSON on stdout (keep it in a shell variable, never a file)
#   vault-handoff.sh import   reads that JSON on stdin, prints {"ok":..,"imported":..}
#
# Run it as the service's user (bin/install.sh does, around its restart). Keys
# only cross stdin/stdout pipes, never argv (so never in ps) and never disk.
# PAYAGENT_HANDOFF=off skips it.
set -euo pipefail
op=${1:?usage: vault-handoff.sh export|import}
sock=${PAYAGENT_HANDOFF_SOCKET:-$HOME/.payagent-vault/handoff.sock}
export PATH="$HOME/.bun/bin:$PATH"

case "${PAYAGENT_HANDOFF:-}" in [Oo][Ff][Ff]) echo "handoff is off (PAYAGENT_HANDOFF=off)" >&2; exit 1 ;; esac
dir=$(dirname "$sock")
if [ -L "$dir" ] || [ ! -d "$dir" ] || [ ! -O "$dir" ]; then
  echo "refusing $dir: missing, a symlink or not owned by $(id -un)" >&2; exit 1
fi
if [ -n "$(find "$dir" -maxdepth 0 -perm /077 2>/dev/null)" ]; then
  echo "refusing $dir: other users can reach it (want 0700)" >&2; exit 1
fi

# Send stdin as one line, print the reply. The socket path goes in the env:
# bun drops argv after `-e code`.
client='const net=require("net");let i="";process.stdin.setEncoding("utf8");
process.stdin.on("data",d=>i+=d).on("end",()=>{const c=net.connect(process.env.HANDOFF_SOCK,()=>c.write(i.trim()+"\n"));
let o="";c.setEncoding("utf8");c.on("data",d=>o+=d);c.on("end",()=>process.stdout.write(o));
c.on("error",e=>{process.stderr.write("handoff socket: "+e.message+"\n");process.exit(1)})});'
run() { HANDOFF_SOCK="$sock" bun -e "$client"; }

case "$op" in
  export)
    [ -S "$sock" ] || { echo "no handoff socket at $sock (process too old, or not running)" >&2; exit 1; }
    out=$(printf '{"op":"export"}' | run)
    case "$out" in '{"ok":true,'*) printf '%s' "$out" ;; *) echo "${out:-no reply}" | head -c 200 >&2; exit 1 ;; esac
    ;;
  import)
    in=$(cat)
    [ -n "$in" ] || { echo "nothing to import" >&2; exit 1; }
    req=$(printf '%s' "$in" | sed 's/^{"ok":true,/{"op":"import",/')
    # The new process may still be opening its socket: retry for ~30s.
    for _ in $(seq 1 15); do
      if [ -S "$sock" ] && out=$(printf '%s' "$req" | run 2>/dev/null) && [ -n "$out" ]; then
        printf '%s\n' "$out"
        case "$out" in *'"ok":true'*) exit 0 ;; *) exit 1 ;; esac
      fi
      sleep 2
    done
    echo "handoff socket never answered at $sock" >&2; exit 1
    ;;
  *) echo "unknown op: $op" >&2; exit 2 ;;
esac
