#!/bin/sh
# Creates four accounts for local testing (alice, bob, carol, dave) in the running server.
# Local test data only: the shared password lives in this file on purpose.
#
#   sh scripts/seed-test-users.sh
for u in alice bob carol dave; do
  docker compose exec -T game alliance user-create "$u" secret1 || true
done
