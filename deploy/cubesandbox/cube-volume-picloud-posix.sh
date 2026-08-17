#!/usr/bin/env bash
# Copyright (c) 2026 PiCloud contributors.
# SPDX-License-Identifier: Apache-2.0
#
# CubeSandbox v0.6 binary Volume Plugin for an already-mounted POSIX shared
# filesystem. Production operators mount the same filesystem at
# /data/cube-shared/volume on every Cube node and on the trusted Workspace Data
# Mover. The local profile uses a single host directory at that path.

set -euo pipefail

readonly DEFAULT_BASE_DIR="/data/cube-shared/volume"
readonly VOLUME_ID_PATTERN='^pcw-[0-9a-f]{48}$'
readonly VOLUME_WORKSPACE_DIRECTORY="workspace"

operation=""
volume_id=""
name=""
sandbox_id=""
namespace=""
ref_count=""
volume_base_dir="$DEFAULT_BASE_DIR"
private_data=""
metadata=""

fail() {
  printf '%s\n' '{"error":"picloud POSIX volume operation failed"}'
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --op)
      (($# >= 2)) || fail
      operation="$2"
      shift 2
      ;;
    --volume-id)
      (($# >= 2)) || fail
      volume_id="$2"
      shift 2
      ;;
    --name)
      (($# >= 2)) || fail
      name="$2"
      shift 2
      ;;
    --sandbox-id)
      (($# >= 2)) || fail
      sandbox_id="$2"
      shift 2
      ;;
    --namespace)
      (($# >= 2)) || fail
      namespace="$2"
      shift 2
      ;;
    --ref-count)
      (($# >= 2)) || fail
      ref_count="$2"
      shift 2
      ;;
    --volume-base-dir)
      (($# >= 2)) || fail
      volume_base_dir="$2"
      shift 2
      ;;
    --private-data)
      (($# >= 2)) || fail
      private_data="$2"
      shift 2
      ;;
    --metadata)
      (($# >= 2)) || fail
      metadata="$2"
      shift 2
      ;;
    *)
      fail
      ;;
  esac
done

[[ "$volume_id" =~ $VOLUME_ID_PATTERN ]] || fail
[[ "$volume_base_dir" == "$DEFAULT_BASE_DIR" ]] || fail
readonly volume_path="${DEFAULT_BASE_DIR}/picloud-posix-${volume_id}"
readonly workspace_path="${volume_path}/${VOLUME_WORKSPACE_DIRECTORY}"

assert_safe_root() {
  [[ -d "$DEFAULT_BASE_DIR" && ! -L "$DEFAULT_BASE_DIR" ]] || fail
}

assert_safe_volume() {
  [[ -d "$volume_path" && ! -L "$volume_path" ]] || fail
  local resolved_root resolved_volume
  resolved_root="$(realpath "$DEFAULT_BASE_DIR")"
  resolved_volume="$(realpath "$volume_path")"
  [[ "$resolved_volume" == "${resolved_root}/picloud-posix-${volume_id}" ]] || fail
}

assert_safe_workspace() {
  [[ -d "$workspace_path" && ! -L "$workspace_path" ]] || fail
  local resolved_volume resolved_workspace
  resolved_volume="$(realpath "$volume_path")"
  resolved_workspace="$(realpath "$workspace_path")"
  [[ "$resolved_workspace" == "${resolved_volume}/${VOLUME_WORKSPACE_DIRECTORY}" ]] || fail
}

case "$operation" in
  create)
    [[ -z "$name" || "$name" == "$volume_id" ]] || fail
    assert_safe_root
    if [[ -e "$volume_path" && ! -d "$volume_path" ]] || [[ -L "$volume_path" ]]; then
      fail
    fi
    mkdir -p -- "$volume_path"
    chmod 0700 -- "$volume_path"
    chown 1000:1000 -- "$volume_path"
    if [[ -e "$workspace_path" && ! -d "$workspace_path" ]] || [[ -L "$workspace_path" ]]; then
      fail
    fi
    mkdir -p -- "$workspace_path"
    chmod 0700 -- "$workspace_path"
    chown 1000:1000 -- "$workspace_path"
    printf '%s\n' '{"token":"","private_data":"picloud-posix-v2","error":""}'
    ;;
  destroy)
    assert_safe_root
    if [[ ! -e "$volume_path" ]]; then
      printf '%s\n' '{"error":""}'
      exit 0
    fi
    assert_safe_volume
    # Destruction is intentionally conservative. Retention/GC must clear a
    # volume through PiCloud's fenced workflow before Cube can remove it.
    rmdir -- "$volume_path" 2>/dev/null || fail
    printf '%s\n' '{"error":""}'
    ;;
  attach)
    [[ -n "$sandbox_id" && -n "$namespace" && "$ref_count" =~ ^[0-9]+$ ]] || fail
    [[ -z "$private_data" || "$private_data" == "picloud-posix-v2" ]] || fail
    assert_safe_root
    assert_safe_volume
    assert_safe_workspace
    printf '{"host_path":"%s","metadata":{"driver":"picloud-posix-v2"},"error":""}\n' \
      "$workspace_path"
    ;;
  detach)
    [[ -n "$sandbox_id" && -n "$namespace" && "$ref_count" =~ ^[0-9]+$ ]] || fail
    [[ -z "$metadata" || "$metadata" == '{"driver":"picloud-posix-v2"}' ]] || fail
    printf '%s\n' '{"error":""}'
    ;;
  *)
    fail
    ;;
esac
