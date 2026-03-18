#!/usr/bin/env bash
# Convenience wrapper — runs the job-agent CLI inside Docker.
#
# Usage:
#   ./run.sh wizard
#   ./run.sh search --remote-only
#   ./run.sh apply "https://wellfound.com/jobs?..."
#   ./run.sh bank list
#
# Resume setup:
#   Copy your resume into the data/ directory before running the wizard:
#     cp ~/Documents/resume.pdf data/resume.pdf
#   Then the wizard will find it automatically at: data/resume.pdf

set -e

# Build the image if it doesn't exist yet
if ! docker image inspect job-agent:dev &>/dev/null; then
  echo "Building job-agent image (first run, takes ~2 min)..."
  docker build -t job-agent:dev .
fi

docker run --rm -it \
  --env-file .env \
  -v "$(pwd)/data:/app/data" \
  job-agent:dev "$@"
