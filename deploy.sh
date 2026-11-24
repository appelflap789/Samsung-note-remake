#!/usr/bin/env bash
# Ship the current working copy to the home server and rebuild the container.
# Notes in ~/samsung-notes/data on the server are never touched.
set -euo pipefail
HOST=${DEPLOY_HOST:-jacob228@192.168.1.161}
KEY=${DEPLOY_KEY:-$HOME/.ssh/id_ed25519_jacob228}
DIR=samsung-notes
cd "$(dirname "$0")"
tar --exclude=node_modules --exclude=dist --exclude=data --exclude=.git -czf - . |
  ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST" \
    "set -e; mkdir -p $DIR/data; cd $DIR; rm -rf src public; tar -xzf -; docker compose up -d --build --remove-orphans; docker image prune -f >/dev/null"
echo "Deployed."
