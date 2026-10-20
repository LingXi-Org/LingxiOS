# Final release integration failures

Before edits, PR36 head 79112d2fb63a745997968aa140e1d831d62af4a7 failed
release-gates run 39397514245 after 657 passing tests and the real PostgreSQL,
Worker recovery, distributed workspace, capacity and operation-context checks.
The unchanged Worker image smoke check could not access `/app/db/schema-012.sql`.

The public package resource was added for the schema12-to-13 upgrade, but both
the Docker build-context allowlist and the final image COPY omitted it. Fix
both lists and rerun the existing complete release gate. Do not change the
Worker command, permissions, mounts, AppArmor or sandbox settings.

Independent evidence verification also found a stale SHA256SUMS entry for
`product-typecheck.log`. The committed artifact is `product-typecheck.txt`,
already listed separately with the same hash. Remove only the nonexistent
duplicate name and retain the actual artifact and original observations.
