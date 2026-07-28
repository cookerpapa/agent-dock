#!/bin/sh
set -eu

attempt=1
while [ "$attempt" -le 3 ]; do
  if npm "$@"; then
    exit 0
  fi

  if [ "$attempt" -eq 3 ]; then
    exit 1
  fi

  sleep "$((attempt * 2))"
  attempt="$((attempt + 1))"
done
