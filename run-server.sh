#!/usr/bin/env bash
# Persistent dev server: bound to all interfaces so the preview proxy can reach it.
cd "$(dirname "$0")"
exec npx tsx server.ts
