# Language-neutral wire contract

`snapshot.schema.json` is the single source of truth for schemaVersion 1 public JSON.
Go types in `internal/contract` and TypeScript types in `web/src/contract.ts` must
decode the same corpus. A drift between those encodings fails `npm run check:port`.

Meanings that Go zero values and `omitempty` must not erase:

- `null` is an observed absence (unpriced rate, unknown remaining).
- omitted is "field not published on this object".
- `0` is a measured zero (remaining 0%, used 0).
- `actual` vs `estimated` vs `unknown` stay distinct on every numeric claim.
- integers stay integers; timestamps are ISO-8601 strings or unix-ms integers, never mixed.

Known product defects live in `corpus/known-defects.json` with Linear IDs.
They are expected failures, not golden snapshots.
