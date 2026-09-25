# Operations

## Service

Each 10-second cycle analyses the full retained history. The store keeps usage rows and quota
observations in memory, reads only rows added since the previous cycle, refetches rows an ingest
updated, and reloads everything after retention, a raw database write, a valuation setting change,
or 15 minutes. Collection backs off after consecutive failures, doubling from two minutes up to 30,
and a refused credential (401/403) waits 30 minutes before it is sent again.

When deploying a new release, preserve the previous release and the history database, deploy the tested source snapshot, then verify the UI and collection status.

An example user systemd unit lives in `deploy/quota-monitor.service`; it uses `%h` for the home directory and a `releases/current` path you point at the release you installed. Restart with `systemctl --user restart quota-monitor.service`. For rollback, restore the previous unit from the deployment backup to `~/.config/systemd/user/quota-monitor.service`, run `systemctl --user daemon-reload`, then restart the service. Keep the history database in place. To stop the monitor entirely, use `systemctl --user stop quota-monitor.service`; this does not affect OpenCodex. The app stores private quota and normalized usage history in `QUOTA_DATA_DIR`; source account files remain read-only.

Backing up that history, restoring it, and checking which release is actually running are described
under [Backup, recovery and release check](#backup-recovery-and-release-check).

## Backup, recovery and release check

A daily timer (`deploy/quota-history-backup.timer`, 04:00) runs `deploy/backup-history.py`, installed to
`~/.local/share/quota-monitor/tools/backup-history.py` so removing a worktree cannot stop it. It writes a
verified online copy to `~/.local/state/quota-monitor-backups/daily` (set by `--directory` in the unit), keeps seven, and records each file's sha256 in
`owned-backups.json`. Reinstall the script with `install -m 0700 deploy/backup-history.py
~/.local/share/quota-monitor/tools/` after changing it.

Four kinds of record live in the history database, and they do not expire by the same rule.

| Record | Tables | When it is dropped |
|---|---|---|
| Usage and quota samples | `usage`, `samples` | Older than the retention window (90 days by default) |
| Price evidence | `price_evidence`, `usage_prices` | With the usage rows the link points at; a record nothing points at goes too |
| Quota measurement evidence | `quota_observations` | Same transaction and same boundary as the sample it explains |
| Model roster | `modelRosterV1` in `meta` | **A different rule.** Never by age |

The roster forgets a model only when three things are true at once: the configuration no longer
lists it, a usage lookup that actually ran no longer finds it, and its last activity is older than
the completeness boundary the retention pass advances. A lookup that failed forgets nothing, and a
model that left the configured list keeps its identity and its first sighting while its listing
ends. That is why a changed model list does not shorten existing history.

### Backup

Do not `cp` `history.sqlite` while the service is running. The database uses WAL, so changes that
have not been checkpointed yet live beside the main file and a plain copy is not consistent. Let
SQLite write the copy instead, read-only, without stopping the service:

```sh
umask 077
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite';\
  const db = new DatabaseSync(process.argv[1], { readOnly: true });\
  db.exec(\"VACUUM INTO '\" + process.argv[2] + \"'\"); db.close();" \
  ~/.local/state/quota-monitor/history.sqlite /path/to/backup/history.sqlite
chmod 600 /path/to/backup/history.sqlite
```

The `umask` and `chmod` are not decoration. The live database is created `0600` on purpose, but
`VACUUM INTO` writes its destination under whatever umask is in effect — `0644` on a normal one —
so a backup left in a traversable directory would expose this history to other local users.

Keep deployment snapshots outside the data directory, for example in `<snapshots>/<branch>/deploy-<UTC>/`, holding the
database copy, the previous unit file, and a `deployment.json` recording what was deployed, the
source commit it came from, the release digest, a per-file sha256 manifest, and the rollback path.

Record two things in that folder at backup time, because a restore cannot be verified without them.
First, a fingerprint of the stored rows, which is what the restore is checked against:

```sh
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; import {createHash} from 'node:crypto';\
  const db = new DatabaseSync(process.argv[1], { readOnly: true }); const out = {};\
  out.schema = db.prepare(\"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name\").all();\
  const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name\").all();\
  for (const { name } of tables) {\
    const id = '\"' + name.replaceAll('\"', '\"\"') + '\"';\
    const cols = db.prepare('PRAGMA table_info(' + id + ')').all()\
      .map(c => '\"' + c.name.replaceAll('\"', '\"\"') + '\"').join(',');\
    const h = createHash('sha256'); let n = 0;\
    for (const row of db.prepare('SELECT * FROM ' + id + ' ORDER BY ' + cols).iterate()) { h.update(JSON.stringify(row)); n++; }\
    out[name] = { rows: n, sha256: h.digest('hex') }; }\
  db.close(); console.log(JSON.stringify(out, null, 1));" \
  /path/to/backup/history.sqlite > /path/to/backup/rows.json
```

The schema entries include table constraints and explicit indexes; unchanged rows with a missing
primary key are not an intact restore. Row counts alone would not do: a record whose contents changed keeps its count. Neither would a
fixed list of tables. Which tables a database holds depends on the release that wrote it — the
schema has gained tables over time and older files simply do not have the newer ones — so the
command asks the file what it contains instead of being told. That also covers `meta`, where the
import cursor, the completeness boundary and the model roster live; a restore that lost those would
otherwise pass while leaving the collector unable to resume correctly.

Second, record the four release readings described below, so it is clear which build produced this
history.

### Recovery

Stop the unit, move the current database aside rather than deleting it, put the copy in place, then
start. Two things decide whether this works.

Move `history.sqlite`, `history.sqlite-wal` and `history.sqlite-shm` as one set, and make sure no
old `-wal` is left beside a restored main file. A copy made with `VACUUM INTO` is a single file with
the log already folded in; an old write-ahead log left next to it would be replayed over the top.

Verify in two separate steps, because they answer different questions. Before starting the service,
run the same fingerprint command against the restored file, writing it somewhere else, and compare:

```sh
# ...the fingerprint command above, but ending in:
#   /path/to/restored/history.sqlite > /tmp/restored-rows.json
diff /path/to/backup/rows.json /tmp/restored-rows.json && echo "the restore matches the backup"
```

Send it to a scratch path, never back over `rows.json`. That file is the only trusted record of what
the backup contained, and overwriting it with output taken from the restored copy destroys the thing
the comparison was supposed to use — after which any restore agrees with itself.

That step says the restore is intact. After starting, read the API and confirm it publishes the same
records again — that says the service can serve them. The two can fail independently, so do not
collapse them into one.

### Rollback

Restore the previous unit as described under [Service](#service). The history database is not part
of a rollback: leave it in place. The schema has only ever gained fields, so an earlier release has
so far read the same file without trouble — but confirm it for the release you are rolling back to
rather than assuming it. Test it on a disposable copy first: restore the backup into a scratch
directory, point the older release at it with `QUOTA_DATA_DIR`, and check that the API still
publishes the four records. Doing that on the live database instead is a real risk, because an
older collector that starts successfully will also ingest and run retention against it.

### Release check

Four things can legitimately disagree, and each is read differently.

| Reading | How to read it | What it does not tell you |
|---|---|---|
| Source commit | `git -C <checkout> rev-parse HEAD` and `git -C <checkout> status --porcelain` | Nothing about what is installed. A dirty tree is not a release candidate |
| Installed release | `systemctl --user show quota-monitor.service -p WorkingDirectory --value` **and** `-p ExecStart --value`, then check that directory against the `manifest` in the most recent `deployment.json` | The directory name is not necessarily a commit. It can be the digest of the deployed archive. And `WorkingDirectory` alone does not say what runs: Node loads `server.mjs` and its relative imports from the `ExecStart` path |
| Running service | `systemctl --user show quota-monitor.service -p ActiveState -p ExecMainPID -p ExecMainStartTimestamp -p NRestarts`, then `readlink /proc/<pid>/cwd` **and** the process command line in `/proc/<pid>/cmdline` | Editing the unit file changes nothing until a restart, so the running path can be an older release. The cwd alone can agree while the command line runs code from somewhere else |
| Last collection | `curl -s http://127.0.0.1:8787/api/v1/snapshot` and read `analytics.status`, `lastCollectedAt`, `usageObservedAt`, `usageObservedSince`, `historyStartedAt` | A file modification time is not a collection time |

A matching manifest proves the installed files have not changed since they were deployed. It does
not prove where they came from; that is what `sourceHead` and the recorded overlay list in
`deployment.json` are for. The two are different claims.

Comparing the installed files against that manifest:

```sh
UNIT=quota-monitor.service
PID=$(systemctl --user show $UNIT -p ExecMainPID --value)
node --input-type=module -e "import {createHash} from 'node:crypto'; import {readFile} from 'node:fs/promises';\
  const rec = JSON.parse(await readFile(process.argv[1], 'utf8'));\
  const [wd, execStart, runCwd, pid] = process.argv.slice(2);\
  const runArgs = (await readFile('/proc/' + pid + '/cmdline', 'utf8')).split('\0').filter(Boolean);\
  const runEnv = (await readFile('/proc/' + pid + '/environ', 'utf8')).split('\0');\
  const unitArgs = execStart.match(/^\{ path=([^ ;]+) ; argv\[\]=([^;]+) ; /);\
  const expected = [rec.nodeExecutable, rec.release + '/src/server.mjs'];\
  const same = args => args?.length === 2 && args.every((v, i) => v === expected[i]);\
  const off = [];\
  if (!rec.nodeExecutable || !rec.manifest['src/server.mjs']) off.push('missing executable or entrypoint provenance');\
  if (!unitArgs || unitArgs[1] !== expected[0] || !same(unitArgs[2].trim().split(/\s+/))) off.push('unsupported ExecStart argv');\
  if (!same(runArgs)) off.push('unsupported running argv');\
  if (runEnv.some(v => v.startsWith('NODE_OPTIONS=') && v.slice(13).trim())) off.push('NODE_OPTIONS is not supported');\
  if (wd !== rec.release) off.push('WorkingDirectory');\
  if (runCwd !== rec.release) off.push('running cwd');\
  if (off.length) { console.log(JSON.stringify({ error: 'these do not point at the recorded release',\
    recorded: rec.release, off }, null, 1)); process.exit(1); }\
  const bad = [];\
  for (const [f, want] of Object.entries(rec.manifest)) {\
    const got = createHash('sha256').update(await readFile(rec.release + '/' + f)).digest('hex');\
    if (got !== want) bad.push(f); }\
  console.log(JSON.stringify({ release: rec.release, sourceHead: rec.sourceHead,\
    entries: Object.keys(rec.manifest).length, mismatched: bad }, null, 1));\
  process.exitCode = bad.length ? 1 : 0;" \
  <snapshots>/<branch>/deploy-<UTC>/deployment.json \
  "$(systemctl --user show $UNIT -p WorkingDirectory --value)" \
  "$(systemctl --user show $UNIT -p ExecStart --value)" \
  "$(readlink /proc/$PID/cwd)" \
  "$PID"
```

The four arguments after the record are what make this a check rather than a formality. Without them
the command hashes whatever directory the record names, so a stale record or a hand-edited unit would
produce an empty `mismatched` list for a release that is not the one running. All four have to agree
with the record before a single file is hashed: `WorkingDirectory` and `ExecStart` can diverge in the
unit, and the running process can differ from both until someone restarts it.

This check supports this installation's exact invocation: the recorded `nodeExecutable` followed
by the manifest-covered `src/server.mjs`, with no other arguments. It compares the complete
NUL-separated process argv and rejects nonempty `NODE_OPTIONS`, so a decoy first script, preload
or option cannot be mistaken for the entrypoint. It deliberately rejects other systemd output
formats, paths containing whitespace, and Node invocation styles rather than guessing. Record
`nodeExecutable` in `deployment.json`; an older record without it needs an explicit provenance
update before this check can pass. This identifies the running entrypoint, not arbitrary loader
or operating-system tampering.

It also exits non-zero when anything is wrong — a disagreeing pointer or a file whose hash moved.
Printing a populated `mismatched` list and still exiting 0 would let any automation calling this
wave through an installation that has been modified since it was deployed.

Which disagreements are acceptable:

- Source ahead of the installed release: normal between a merge and a deployment.
- `deploy/quota-monitor.service` naming a different release than the installed unit: read the
  installed one, because that is the fact and the repository file is only a template — but do not
  leave it that way. A lagging template is a rollback waiting to happen: the release it still names
  is usually the one the current deployment replaced, so installing it unchanged would quietly put
  the previous build back. A unit file with valid syntax starts without complaint, so the first
  sign would be the responses changing. Bring the template back in sync as its own change, separate
  from any deployment.
- An installed release matching no commit tree: fine when the deployment record says it was a base
  plus a named overlay, and a problem when the record says otherwise.
- The running process working directory differing from the installed unit: not acceptable. A
  restart is missing.
- `lastCollectedAt` older than twice the collection interval: not acceptable.

Run the gates on the release candidate source: `npm run check`, `npm test`, `npm run check:ui` and
`npm run check:ui:flow`. The last two need a Chromium binary.

### Direct quota adapters change what the check covers

Three separate facts, easy to collapse into one and wrong if you do.

**Whether adapters are registered.** `analytics.directQuota` appears in the response only when the
entry point passes an adapter list. Present means direct collection is on; absent means off. Read it
rather than assuming.

What decides it is `QUOTA_DIRECT_PROVIDERS`: the entry point assembles the adapter list from that
variable, and with it unset the list is empty and nothing is fetched or published. So a reader who
sees `directQuota: null` can trace the reason rather than guessing, and turning direct collection on
is a unit change followed by a restart — not something that happens on its own when the code lands.

**Other network paths exist regardless.** With adapters off, the Ollama usage probe and the
OpenCodex management refresh still reach out when they are configured. "Direct collection is off"
does not mean "this service makes no outbound requests".

**An expired credential is scoped to its account.** When a direct lookup credential expires, that
account is marked failed and a retry is scheduled; the rest of collection continues. So the check
reads per-account direct status and overall collector health on separate lines, and one failed
account is not a stopped collector.

Read all three in one request:

```sh
curl -s http://127.0.0.1:8787/api/v1/snapshot | jq '{
  adaptersRegistered: (.analytics.directQuota != null),
  collector: .analytics.status,
  lastCollectedAt: .analytics.lastCollectedAt,
  intervalSeconds: .analytics.sampleIntervalSeconds,
  directQuota: .analytics.directQuota,
  accounts: [.providers[] | {provider: .id,
    accounts: [.accounts[] | {id, direct: .directQuota}]}]
}'
```

`intervalSeconds` is the freshness yardstick: `lastCollectedAt` older than twice it is a problem.
With no adapters registered the API omits those fields, so the filter above prints `directQuota:
null` and `direct: null`, and the check stops at the collector line. A null there means the feature
is off, not that a lookup failed.
