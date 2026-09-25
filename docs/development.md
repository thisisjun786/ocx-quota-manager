# Development

## Development

```sh
npm run check
npm test
npm run check:ui        # every screen, needs a Chromium binary
npm run check:ui:flow   # the route from the summary to a price check and back, on its own
```

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

`src/snapshot.mjs` owns source-file translation, `src/server.mjs` owns HTTP, `public/` owns presentation. Tests use isolated synthetic files and ephemeral loopback ports. No tests call paid providers. Use isolated test data and compare the rendered dashboard at desktop, tablet and mobile widths.

`tests/integration-contract.test.mjs` holds only what no single module owns: the response where
several states are wrong at once. It drives a real collector against a temporary OpenCodex home
and checks that an unpriced model, a model the configuration dropped and a failed usage read stay
three separate facts; that the five usage periods end at one anchor and carry one set of totals on
the account, the provider and the price-gap surfaces; and that the source status, the retained
price record and the price-gap report never contradict each other in the same payload.

The same file checks what the macOS client reads. Its decode surface is transcribed by hand from
`macos/Sources/QuotaModel.swift`, and a test compares that transcription against the Swift source,
so a field added, removed or made optional over there fails in Node before anyone opens Xcode. The
saved menu-bar key is checked the same way: the order of its parts is compared in both
`public/views.js` and the Swift panel, because swapping two parts keeps every part and still breaks
every saved selection. **None of this runs Swift.** `bash macos/build.sh` on a Mac is the only real
decode proof, and it refuses to run anywhere else. When the mirror test fails, either the
transcription is stale or the contract genuinely changed — decide which before editing the table.
