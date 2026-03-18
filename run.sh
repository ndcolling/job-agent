#!/usr/bin/env bash
# Convenience wrapper — runs the job-agent CLI inside Docker.
# Usage: ./run.sh wizard
#        ./run.sh search --remote-only
#        ./run.sh apply "https://wellfound.com/jobs?..."
#        ./run.sh bank list

set -e

# Build the image if it doesn't exist yet
if ! docker image inspect job-agent:dev &>/dev/null; then
  echo "Building job-agent image..."
  docker compose build
fi

docker compose run --rm job-agent "$@"
