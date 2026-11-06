# Repository agent instructions

## Project continuity

- Read `docs/t3-handoff-2026-11-05.md` for the Codex Cloud handoff, remaining configuration work and existing product decisions. Use `docs/operations.md` for current release and recovery procedures; recheck dated deployment facts before acting.
- The T3 development preview has its own local database. Its `/setup` page does not mean the existing production installation needs initialization or recovery.

## Development toolchain

- Use the Node 24 version pinned in `.nvmrc` and Python 3.10+ for recovery tests. On this Mac mini, prepend `/opt/homebrew/opt/node@24/bin:/opt/homebrew/opt/python@3.13/libexec/bin` to `PATH` before running npm commands; do not use the macOS system Python 3.9.
- Run browser suites sequentially. Use the existing isolated workspace and synthetic test data; production credentials are not required for the local quality gates.

## Database backup and restore

- Whenever a migration creates, renames, or removes a persisted table, update the backup and restore table lists in the same change, even if the feature is unrelated to backups. Review `BACKUP_TABLES` and `INTERNAL_TABLES` in `src/lib/backups/export.ts`, `BACKUP_TABLE_GROUPS` in `src/lib/backups/table-groups.ts`, and `DatabaseBackupTable` in `src/lib/backups/types.d.ts`.
- Put every backed-up table in exactly one group. Keep `BACKUP_TABLES` in foreign-key dependency order so restore inserts parents before children and deletes them in reverse order. Exclude a table only when its contents are derived or internally managed, and document why.
- When adding a table, check backup and restore behavior both before and after its migration is applied. Keep older full backup documents restorable.
