# Agent rules

## Deployment

A routine change to this project may be deployed to the existing installation without asking again
when all of these hold:

- It is committed, and `go vet ./... && go test ./...`, `npm run typecheck` and `npm test` pass on
  that commit with nothing skipped or failing.
- It is deployed with `scripts/deploy.sh` to the installed `quota-monitor.service`. The script copies
  the history database (SQLite online backup) and the unit into its snapshot directory and records the
  previous release. When the health check fails it restores only the previous unit and the
  `releases/current` pointer and restarts; the history database stays in place, and the snapshot copy
  is kept for a manual recovery.
- Afterwards the [release check](docs/operations.md#release-check) (installed release, running
  binary and its manifest hash, last collection) is confirmed and reported together with the deployed
  commit and the rollback path.

Jun's explicit approval is still required for a deployment with failing or skipped checks, for a new
installation, for changes to authentication, credentials, permissions, network exposure
(`QUOTA_HOST`, `QUOTA_PORT`, `QUOTA_PUBLIC_ORIGIN`) or other security settings, for anything that
sends data off this machine, and for changes outside this repository.
