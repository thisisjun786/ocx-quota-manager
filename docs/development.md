# Development

Everything outside Go is TypeScript: the UI in `web/src`, and the build scripts, browser checks
and contract tests in `scripts/` and `tests/`, which Node 24 runs directly.

```sh
npm ci
go vet ./... && go test -race ./...
npm run typecheck       # web/ and scripts/ + tests/ (tsconfig.tools.json)
npm test                # contract, store-compatibility and embed tests
npm run check:ui        # every screen, needs a Chromium binary
npm run check:ui:flow   # the route from the summary to account detail and back, on its own
npm run check:port:ui   # the release binary's embed and guards in headless Chromium
```

The browser checks build the UI, sync `webembed/static`, and run the Go `cmd/ui-fixture` server
against a synthetic snapshot from `scripts/ui-fixture.ts`. The server re-reads that snapshot on every
request, so a check that changes the world writes it again (`publish()`) before refreshing.

`npm run check:ui:flow` walks one route in a real headless browser: summary, period, provider and
account, calculation detail, price check, source, back, and then the same screen with the server
unreachable. It exists separately from `npm run check:ui` so a failure can be reproduced in about
twenty-five seconds rather than behind every other assertion and a minute and a half of them;
`npm run check:ui` runs it too, so nothing is checked in only one of the two.

When it fails, the last line says how far it got — `ui-flow: reached 06 sources of 09` — and every
assertion carries its step, as in `[flow 06] the period, the search, the filter, the open detail and
the keyboard focus all survive an unattended refresh`. The step that failed also leaves
`FAIL-06.png` and `FAIL-06.json` next to the other screens, the second holding the period, search,
filter, open disclosures, focus, title and notice at that moment. Later steps are skipped, because
the route is one continuous state and carrying on would report damage the first failure caused.

Both commands write their screens outside the repository — `QUOTA_UI_CHECK_SHOTS` chooses where,
and the default is a temporary directory — so running a check never dirties the working tree. The
route leaves sixteen of them under `flow/`: summary, accounts with the calculation detail open, the
scoped price list, and the disconnected state, each in light and dark at 1280px and 390px.
`QUOTA_UI_FLOW_STOP=05 npm run check:ui:flow` stops after that step while debugging. Such a run
never reports success: it says `PARTIAL`, states that it is not a pass, and exits non-zero, because
a run that skipped the states this route exists to watch must not be quotable as a whole one.

Go tests use isolated synthetic files and ephemeral loopback ports. No test calls a paid provider.
Behaviour lives in Go packages and is tested there: quota readings in `internal/calc`, history and
retention in `internal/store`, provider reads in `internal/collect`, and the assembled response in
`internal/runtime`.

The macOS client's decode surface is checked only by `bash macos/build.sh` on a Mac; nothing here
runs Swift.
