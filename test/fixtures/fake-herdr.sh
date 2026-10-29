#!/bin/sh
# Mimics herdr CLI failure modes for tests. First arg selects the behaviour.
case "$1" in
  stderr-json) printf '%s\n' '{"error":{"code":"agent_not_ready","message":"blocked during startup"},"id":"cli:agent:start"}' >&2; exit 1 ;;
  stdout-json-error) printf '%s\n' '{"error":{"code":"agent_blocked","message":"nope"}}'; exit 0 ;;
  ok) printf '%s\n' '{"id":"x","result":{"agent":{"name":"a"}}}'; exit 0 ;;
  *) echo "plain failure" >&2; exit 2 ;;
esac
