// The route a person actually walks: summary -> period -> provider and account ->
// calculation detail -> automatic pricing -> source -> back, then the same screen with the server
// unreachable. It runs inside npm run check:ui and on its own through npm run check:ui:flow,
// so a failure here can be reproduced in seconds instead of behind the whole check.
//
// Two rules shape everything below. The five states are set to values the product does not
// default to, because a refresh that reset them to the defaults would otherwise pass. And the
// page clock is pinned for the connection-failure step, so two readings taken at the same
// offset are identical no matter how much real time passed between them.
import { buildFixture } from './ui-fixture.ts';
import { openDashboard, SCREENS } from './ui-browser.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STEPS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];
const LAST = STEPS[STEPS.length - 1];

// What the route has to carry. focus reports the key the product restores by, not the tag:
// a disclosure comes back through data-expand, a link and a button through data-focus.
const STATE = '(() => ({' +
  ' period: document.querySelector(\'#period-picker button[aria-pressed="true"]\')?.dataset.period ?? null,' +
  ' detailPeriod: document.querySelector(".account-details .detail-period select")?.value ?? null,' +
  ' search: document.getElementById("search").value,' +
  ' filter: document.querySelector(\'.price-filters button[aria-pressed="true"]\')?.dataset.priceStatus ?? null,' +
  ' expanded: [...document.querySelectorAll("details[data-expand][open]")].map(el => el.dataset.expand).sort().join(","),' +
  ' focus: (() => { const el = document.activeElement; if (!el) return null;' +
  '   if (el.matches("summary")) return "expand:" + (el.parentElement?.dataset.expand ?? "");' +
  '   return el.dataset.focus ?? el.dataset.provider ?? el.tagName; })() }))()';

// Which keys differ. Used both for the real comparison and to show the comparison bites.
const differences = (actual, wanted) => Object.keys(wanted).filter(key => actual?.[key] !== wanted[key]);

export async function regressionFlow({ page, snapshot, expect, screens = SCREENS }) {
  const { call, evaluate, settle, clickText, publish } = page;
  const shots = join(screens, 'flow');
  const stopAt = process.env.QUOTA_UI_FLOW_STOP ?? null;
  let stopped = false, current = '00', reached = 'none', failedHere = false;

  const check = (condition: unknown, description: string, detail?: unknown) => {
    expect(condition, '[flow ' + current + '] ' + description, detail);
    if (!condition) failedHere = true;
    return condition;
  };
  // A dump must never mask the failure that caused it.
  const dump = async (id, name) => {
    try {
      await mkdir(shots, { recursive: true });
      const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(join(shots, 'FAIL-' + id + '.png'), Buffer.from(shot.data, 'base64'));
      const state = await evaluate('(() => ({ ...' + STATE + ',' +
        ' title: document.getElementById("title")?.textContent ?? null,' +
        // The notice may be holding this check's own timer marker rather than anything the
        // product said, and the product appends its own warnings after it. Name the marker in
        // place rather than replacing the line, or a real warning is lost with it.
        ' notice: (() => { const n = document.getElementById("notice");' +
        '   if (!n || n.hidden) return null;' +
        '   return n.textContent.replace(/동선-타이머-[0-9]+/g, "(route-check refresh marker)");' +
        ' })() }))()');
      await writeFile(join(shots, 'FAIL-' + id + '.json'),
        JSON.stringify({ step: id + ' ' + name, state }, null, 2));
      console.error('ui-flow: state at the failure is in ' + join(shots, 'FAIL-' + id + '.json'));
    } catch (error: any) {
      console.error('ui-flow: could not record the failure state (' + error.message + ')');
    }
  };
  const step = async (id, name, body) => {
    if (stopped) return;
    current = id;
    reached = id + ' ' + name;
    failedHere = false;
    try {
      await body();
    } catch (error: any) {
      expect(false, '[flow ' + id + '] ' + name + ' 중단: ' + error.message);
      failedHere = true;
    }
    if (failedHere) { await dump(id, name); stopped = true; }
    if (stopAt === id) stopped = true;
  };

  const selectPeriod = async short => {
    await clickText('#period-picker button', short);
    return settle('document.querySelector(\'#period-picker button[aria-pressed="true"]\')?.dataset.period ?? null');
  };
  const typeSearch = value => evaluate('document.getElementById("search").value = ' + JSON.stringify(value) +
    '; document.getElementById("search").dispatchEvent(new Event("input")); true');
  // The whole check may already count snapshot requests. Wrapping a second time would double
  // every tick, so only install when nobody has.
  const counter = () => evaluate('(() => { if (typeof window.__qmFetches === "number") return "existing";' +
    ' window.__qmFetches = 0; const original = window.fetch;' +
    ' window.fetch = (...args) => { if (String(args[0]).includes("/api/v1/snapshot")) window.__qmFetches++;' +
    ' return original(...args); }; return "installed"; })()');
  // Counting requests is not enough: the once-a-minute clock re-render would pass too. Wait for
  // a value only a new response can carry.
  const unattended = async () => {
    await counter();
    const token = '동선-타이머-' + Date.now();
    const prior = snapshot.warnings;
    snapshot.warnings = [token];
    publish();
    try {
      await evaluate('window.__qmFetches = 0; true');
      return await settle('(() => { const notice = document.getElementById("notice");' +
        ' return window.__qmFetches > 0 && notice && notice.textContent.includes(' + JSON.stringify(token) + ')' +
        ' && !document.getElementById("refresh").disabled ? window.__qmFetches : null; })()', 200);
    } finally {
      snapshot.warnings = prior;
      publish();
    }
  };
  const refreshed = async () => {
    await evaluate('document.getElementById("refresh").click(); true');
    return settle('!document.getElementById("refresh").disabled ? true : null');
  };
  // Every injection is recorded here and undone in one place, so a step that throws cannot
  // leave a frozen clock or a blocked network behind for whatever runs after it.
  let pinned = false, injectedFetch = false, cdpOffline = false;
  const restoreAll = async () => {
    try {
      if (cdpOffline) {
        await call('Network.emulateNetworkConditions',
          { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        cdpOffline = false;
      }
      if (injectedFetch || pinned) {
        await evaluate('(() => { if (window.__qmPrevFetch) { window.fetch = window.__qmPrevFetch; window.__qmPrevFetch = null; }' +
          ' if (window.__qmReal) { Date.now = window.__qmReal; window.__qmReal = null; } return true; })()');
        injectedFetch = false;
        pinned = false;
      }
      await call('Emulation.setEmulatedMedia', { features: [] });
      await call('Emulation.clearDeviceMetricsOverride');
      // The next refresh time was written against whatever clock was in force, so press once
      // to put it back on the real one.
      await evaluate('document.getElementById("refresh").click(); true');
      await settle('!document.getElementById("refresh").disabled ? true : null');
    } catch (error: any) {
      expect(false, 'ui-flow could not undo an injection: ' + error.message);
    }
  };

  try {
    await step('01', 'summary', async () => {
      await clickText('#providers button', '요약');
      const rows = await settle('document.querySelectorAll(".summary-provider").length || 0');
      check(rows === snapshot.providers.length, 'the route starts on the summary with every provider listed', rows);
      const period = await selectPeriod('7일');
      check(period === 'weekly', 'the route starts from a period it chose rather than whatever was left over', period);
      check(await evaluate('!document.querySelector("[data-price-check]") && !document.querySelector("#providers [data-provider=prices]")'),
        'the summary has no price-management navigation or confirmation task');
    });

    await step('02', 'period', async () => {
      const before = await evaluate('document.querySelector(".summary-provider .summary-usage .metric > strong")?.textContent ?? null');
      const period = await selectPeriod('24시간');
      check(period === 'twentyFourHour', 'the period picker takes the choice', period);
      const header = await settle('document.querySelector(".summary-columns")?.textContent');
      check(/최근 24시간/.test(header ?? ''), 'the summary column head follows the chosen period', header);
      const after = await evaluate('document.querySelector(".summary-provider .summary-usage .metric > strong")?.textContent ?? null');
      check(before !== null && after !== null && before !== after,
        'the amount itself changes with the period, not only the label beside it', { before, after });
      // 쿼타 소모도 선택 기간을 따른다.
      const quota = await evaluate('(() => { const cell = document.querySelector(".summary-provider .metric.quota-used");' +
        ' return cell ? { label: cell.querySelector("span")?.textContent, value: cell.querySelector("strong")?.textContent } : null; })()');
      check(quota !== null && quota.label === '최근 24시간 쿼타 소모 합계' && quota.value === '≈ 10.8%p',
        'quota consumption follows the amount period', quota);
    });

    await step('03', 'provider-accounts', async () => {
      await clickText('#providers button', 'OpenAI');
      const all = await settle('document.querySelectorAll(".account").length || 0');
      check(all === 3, 'the provider screen lists its accounts', all);
      await typeSearch('계정 1');
      const narrowed = await settle('(() => { const n = document.querySelectorAll(".account").length;' +
        ' return n > 0 && n < ' + all + ' ? n : null; })()');
      check(narrowed === 1, 'the search narrows the list to the one account it names', narrowed);
      const period = await evaluate('document.querySelector(\'#period-picker button[aria-pressed="true"]\')?.dataset.period ?? null');
      check(period === 'twentyFourHour', 'the summary period remains stored while viewing a provider', period);
    });

    await step('04', 'calc-detail', async () => {
      await evaluate('document.querySelector("details.account-details").open = true; true');
      check(await evaluate('document.getElementById("period-picker").hidden'), 'the provider page has no top-level period control');
      await evaluate(`(() => { const s=document.querySelector('.account-details .detail-period select'); s.value='twentyFourHour'; s.dispatchEvent(new Event('change')); })()`);
      const body = await evaluate('document.querySelector(".account-details")?.textContent ?? ""');
      check(/API 환산액/.test(body), 'the calculation detail opens on the account the search left');
      const onSummary = await settle('(() => { const s = document.querySelector("details.account-details[open] > summary");' +
        ' if (!s) return null; s.focus(); return document.activeElement === s ? true : null; })()');
      check(onSummary === true, 'the keyboard is on the disclosure that was opened');
      const before = await evaluate(STATE);
      check(before.filter === null,
        'this screen has no price filter, so only four of the five states exist here and only four are claimed', before.filter);
      const ticked = await unattended();
      check(ticked !== null, 'the ten-second timer fetched and rendered a new snapshot with nobody pressing refresh', ticked);
      const after = await evaluate(STATE);
      const wanted = { period: 'twentyFourHour', detailPeriod: 'twentyFourHour', search: '계정 1', expanded: before.expanded, focus: before.focus };
      check(differences(after, wanted).length === 0,
        'the period, the search, the open detail and the keyboard focus survive an unattended refresh here',
        { after, differs: differences(after, wanted) });
    });

    await step('05', 'automatic-pricing', async () => {
      await typeSearch('');
      await clickText('#providers button', '요약');
      await selectPeriod('5시간');
      check(await evaluate('!document.querySelector("[data-price-check]") && !document.querySelector("#providers [data-provider=prices]")'),
        'price findings in the API never become UI tasks');
      const amount = await evaluate('document.querySelector(".summary-usage .metric > strong").textContent');
      check(amount === '$8.00', 'known reference prices still produce the selected usage amount', amount);
    });
    await step('06', 'sources', async () => {
      await evaluate('document.querySelector("#efficiency details").open = true');
      const basis = await evaluate('document.querySelector("#efficiency").textContent');
      check(/등록된 기준 단가로 자동 계산/.test(basis), 'calculation details explain automatic reference pricing');
      check(await evaluate('document.querySelectorAll("#efficiency a[href]").length > 0'), 'price sources remain available in calculation details');
    });
    await step('07', 'refresh', async () => {
      const before = await evaluate('document.querySelector(".summary-usage .metric > strong").textContent');
      check(await refreshed(), 'normal refresh succeeds');
      check(await evaluate('document.querySelector(".summary-usage .metric > strong").textContent') === before,
        'automatic prices and usage survive refresh');
      check(await evaluate('document.querySelector("#period-picker [aria-pressed=true]").dataset.period') === 'fiveHour',
        'selected period survives refresh');
    });

    await step('08', 'failure', async () => {
      await clickText('#providers button', 'OpenAI');
      await settle('document.querySelectorAll(".account").length || 0');
      await typeSearch('');
      await counter();
      await refreshed();

      // Pin the clock. From here the page's time moves only when __qmSkew moves, so two
      // readings taken at the same offset cannot differ because real seconds went by. Without
      // this, staleness and the warning badge drift on their own and a slow run fails for
      // nothing: both are computed from the current time, not from the response.
      await evaluate('(() => { if (!window.__qmReal) { window.__qmReal = Date.now; window.__qmPin = Date.now(); }' +
        ' window.__qmSkew = 0; Date.now = () => window.__qmPin + window.__qmSkew; return true; })()');
      pinned = true;
      await refreshed();

      const windows = () => evaluate('JSON.stringify([...document.querySelectorAll(".window")].map(el => ({' +
        ' label: el.querySelector(".window-title span")?.textContent ?? "",' +
        ' stale: el.classList.contains("stale"),' +
        ' remaining: el.querySelector(".window-title strong")?.textContent ?? "",' +
        ' badge: el.querySelector(".window-title .badge")?.textContent ?? null,' +
        ' meta: el.querySelector(".window-meta span")?.textContent ?? "" })))');
      // The first window of the first account: its reset is hours away and its account was read
      // seconds ago, so it is the one window that has all three states ahead of it.
      const tracked = () => evaluate('(() => { const el = document.querySelector(".account .window");' +
        ' if (!el) return null; return { label: el.querySelector(".window-title span")?.textContent ?? "",' +
        ' stale: el.classList.contains("stale"),' +
        ' meta: el.querySelector(".window-meta span")?.textContent ?? "" }; })()');
      const usage = () => evaluate('document.querySelector(".provider-analytics .usage-totals .metric > strong")?.textContent ?? null');
      const collected = () => evaluate('document.getElementById("updated")?.textContent ?? null');
      const skew = async value => {
        await evaluate('window.__qmSkew = ' + value + '; true');
        await evaluate('document.getElementById("refresh").click(); true');
        return settle('!document.getElementById("refresh").disabled ? true : null');
      };

      const baseline = await windows();
      const baseUsage = await usage();
      const baseCollected = await collected();
      const start = await tracked();
      check(start !== null && start.stale === false,
        'the window this step follows is fresh to begin with, so its expiry below is a change and not a starting state', start);
      // Comparing two readings proves nothing if both are empty. A broken selector would make
      // every invariance check below pass on a pair of empty lists.
      const baseWindows = JSON.parse(baseline);
      check(baseWindows.length > 0 && baseWindows.some(w => !w.stale),
        'the baseline holds real windows and at least one of them is fresh, so the comparisons below cannot pass on an empty list',
        { windows: baseWindows.length, fresh: baseWindows.filter(w => !w.stale).length });

      // A server that cannot be reached. The browser still thinks it is online and keeps trying,
      // which is the situation the notice is written for.
      await evaluate('(() => { window.__qmPrevFetch = window.fetch;' +
        ' window.fetch = (...args) => String(args[0]).includes("/api/v1/snapshot")' +
        '   ? (window.__qmFetches++, Promise.reject(new TypeError("injected")))' +
        '   : window.__qmPrevFetch(...args); return true; })()');
      injectedFetch = true;
      // The clock is pinned, so the timer cannot start this first failure on its own.
      await evaluate('document.getElementById("refresh").click(); true');
      const dropped = await settle('(() => { const n = document.getElementById("notice");' +
        ' return !n.hidden && n.textContent.includes("연결이 끊겨") && !document.getElementById("refresh").disabled' +
        '   ? n.textContent : null; })()');
      check(dropped !== null, 'a failed lookup says the connection dropped and that what follows is the previous reading', dropped);
      check((await windows()) === baseline, 'every quota window still reads exactly as it did before the failure');
      check((await usage()) === baseUsage, 'the converted amount is still the last one that was read', await usage());
      check((await collected()) === baseCollected, 'and the collection time still names where that reading came from', await collected());

      const tried = await evaluate('window.__qmFetches');
      await evaluate('window.__qmSkew = 11000; true');
      const retried = await settle('(() => window.__qmFetches > ' + tried + ' ? window.__qmFetches : null)()', 200);
      check(retried !== null,
        'the ten-second timer keeps asking while the server is unreachable, with nobody pressing refresh',
        { before: tried, after: retried });
      await skew(0);
      check((await windows()) === baseline,
        'and back at the same instant the windows are unchanged, so anything that moves below moved for a reason');

      // Now move only the clock. No response arrives during any of this.
      await skew(16 * 60000);
      const expired = await tracked();
      check(expired !== null && expired.stale === true && expired.meta === '15분 이상 갱신 없음',
        'with the server still unreachable the page expires the reading it was holding, on its own clock', expired);
      check((await usage()) === baseUsage,
        'while the converted amount stays the retained one, so what moved was the freshness and not the numbers');

      await skew(7 * 3600000);
      const past = await tracked();
      check(past !== null && past.meta === '리셋 후 갱신 대기',
        'once the reset passes the same window says that instead, which is the order the rules put them in', past);

      await skew(0);
      check((await windows()) === baseline, 'back at the pinned instant every window reads as it did at the start');
      await evaluate('(() => { window.fetch = window.__qmPrevFetch; window.__qmPrevFetch = null;' +
        ' Date.now = window.__qmReal; window.__qmReal = null; return true; })()');
      injectedFetch = false;
      pinned = false;
      await refreshed();
      check(await settle('(() => !document.getElementById("notice").textContent.includes("연결이 끊겨") ? true : null)()'),
        'reconnecting clears the disconnected notice');
      await evaluate('window.__qmFetches = 0; true');
      check(await settle('(() => window.__qmFetches > 0 ? window.__qmFetches : null)()', 200) !== null,
        'and the unattended timer runs again on the real clock');

      // Losing the network is a different thing to say, and a different thing to do.
      await call('Network.enable');
      await call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      cdpOffline = true;
      const gone = await settle('(() => { const n = document.getElementById("notice");' +
        ' return navigator.onLine === false && !n.hidden && n.textContent.includes("오프라인") ? n.textContent : null; })()', 120);
      check(gone !== null, 'losing the network says so in its own words rather than the unreachable-server wording', gone);
      check((await evaluate('document.querySelectorAll(".account").length')) === 3,
        'and the accounts that were on screen are still on screen');
      await evaluate('window.__qmFetches = 0; true');
      await new Promise(resolve => setTimeout(resolve, 11500));
      const quiet = await evaluate('window.__qmFetches');
      check(quiet === 0,
        'while the browser reports no network the page stops asking, which is what separates this from a server it simply cannot reach', quiet);

      // Still offline, so nothing can be asked at all. Move only the clock and watch the same
      // window expire anyway. Everywhere above, a failed request was also redrawing the page,
      // so this is the one place that separates the freshness judgement from any reply.
      await evaluate('(() => { if (!window.__qmReal) { window.__qmReal = Date.now; window.__qmPin = Date.now(); }' +
        ' window.__qmSkew = 0; Date.now = () => window.__qmPin + window.__qmSkew; return true; })()');
      pinned = true;
      const beforeQuietly = await tracked();
      check(beforeQuietly !== null && beforeQuietly.stale === false,
        'the followed window is fresh again before the network is taken away', beforeQuietly);
      await evaluate('window.__qmSkew = 16 * 60000; true');
      const expiredQuietly = await settle('(() => { const el = document.querySelector(".account .window");' +
        ' return el && el.classList.contains("stale")' +
        '   ? (el.querySelector(".window-meta span")?.textContent ?? "") : null; })()', 100);
      check(expiredQuietly === '15분 이상 갱신 없음',
        'the reading expires on the clock alone while the browser has no network at all', expiredQuietly);
      check((await evaluate('window.__qmFetches')) === 0,
        'and not one request stood behind it, so the expiry is the page re-reading its own clock rather than a failed reply redrawing it',
        await evaluate('window.__qmFetches'));
      await evaluate('(() => { Date.now = window.__qmReal; window.__qmReal = null; return true; })()');
      pinned = false;
      await call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      cdpOffline = false;
      check(await settle('(() => navigator.onLine && window.__qmFetches > 0 ? true : null)()', 200),
        'and it asks again as soon as the network comes back');
    });

    await step('09', 'evidence', async () => {
      await mkdir(shots, { recursive: true });
      const capture = async name => {
        const png = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        await writeFile(join(shots, name + '.png'), Buffer.from(png.data, 'base64'));
        return png.data.length > 0;
      };
      // Assertions are done. Widths are changed only from here on, because changing the width
      // moves the keyboard focus and would make the checks above depend on capture order.
      const scenes: [string, () => Promise<unknown>][] = [
        ['01-summary', async () => {
          await clickText('#providers button', '요약');
          await settle('document.querySelectorAll(".summary-provider").length || 0');
          await selectPeriod('7일');
        }],
        ['02-accounts', async () => {
          await clickText('#providers button', 'OpenAI');
          await settle('document.querySelectorAll(".account").length || 0');
          await evaluate('document.querySelectorAll("details.account-details").forEach(el => el.open = true); true');
        }],
        ['03-calculation', async () => {
          await clickText('#providers button', '요약');
          await evaluate('document.querySelector("#efficiency details").open = true');
        }],
        ['04-offline', async () => {
          await evaluate('(() => { if (!window.__qmReal) { window.__qmReal = Date.now; window.__qmPin = Date.now(); }' +
            ' window.__qmSkew = 16 * 60000; Date.now = () => window.__qmPin + window.__qmSkew;' +
            ' window.__qmPrevFetch = window.fetch;' +
            ' window.fetch = (...args) => String(args[0]).includes("/api/v1/snapshot")' +
            '   ? Promise.reject(new TypeError("injected")) : window.__qmPrevFetch(...args); return true; })()');
          pinned = true;
          injectedFetch = true;
          await clickText('#providers button', 'OpenAI');
          await settle('document.querySelectorAll(".account").length || 0');
          await evaluate('document.getElementById("refresh").click(); true');
          await settle('(() => document.getElementById("notice").textContent.includes("연결이 끊겨")' +
            ' && !document.getElementById("refresh").disabled ? true : null)()');
        }],
      ];
      let saved = 0;
      for (const [name, arrange] of scenes) {
        await arrange();
        for (const width of [1280, 390]) {
          await call('Emulation.setDeviceMetricsOverride',
            { width, height: width === 1280 ? 1800 : 844, deviceScaleFactor: 1, mobile: width !== 1280 });
          for (const [theme, features] of [['light', []], ['dark', [{ name: 'prefers-color-scheme', value: 'dark' }]]]) {
            await call('Emulation.setEmulatedMedia', { features });
            await settle('document.readyState === "complete" ? true : null');
            if (await capture(name + '-' + theme + '-' + width)) saved++;
          }
        }
        await call('Emulation.setEmulatedMedia', { features: [] });
        await call('Emulation.clearDeviceMetricsOverride');
      }
      check(saved === 16, 'sixteen representative screens are written, outside the repository', { saved, at: shots });
      await restoreAll();
      check(await settle('(() => !document.getElementById("notice").textContent.includes("연결이 끊겨")' +
        ' && document.querySelectorAll(".account").length ? true : null)()'),
        'and the page is back to a working state after the evidence pass');
    });


    // JUN-124: the direct-read basis has to survive the same route as everything else. A
    // detail nobody can keep open is a detail nobody reads.
    await step('10', 'direct-basis', async () => {
      await clickText('#providers button', 'OpenAI');
      await settle('document.querySelectorAll(".account").length ? true : null');
      const opened = await settle('(() => {' +
        ' const a = [...document.querySelectorAll(".account")].find(el => el.querySelector(".account-name")?.textContent === "계정 1");' +
        ' const d = a?.querySelector("details.account-details");' +
        ' if (!d) return null; d.open = true;' +
        ' return d.querySelector(".measurement-origin") ? true : null; })()');
      check(opened === true, 'the account detail opens on the reading basis rather than on an empty panel');
      // The window ids are the menu-bar selection keys. If the basis rows renamed or reordered
      // them, a user's pinned window would quietly point at nothing.
      const keys = await evaluate('(() => {' +
        ' const a = [...document.querySelectorAll(".account")].find(el => el.querySelector(".account-name")?.textContent === "계정 1");' +
        ' return [...a.querySelectorAll(".windows .window .window-title span")].map(s => s.title || s.textContent); })()');
      check(Array.isArray(keys) && keys.includes('주간') && keys.includes('5시간'),
        'the window labels the menu-bar selection is keyed on are unchanged by the basis rows', keys);
      const onSummary = await settle('(() => { const s = document.querySelector("details.account-details[open] > summary");' +
        ' if (!s) return null; s.focus(); return document.activeElement === s ? true : null; })()');
      check(onSummary === true, 'the keyboard is on the disclosure holding the basis');
      const before = await evaluate(STATE);
      const ticked = await unattended();
      check(ticked !== null, 'the ten-second timer refreshed the page while the basis was open', ticked);
      const after = await evaluate(STATE);
      check(differences(after, { period: before.period, search: before.search,
        expanded: before.expanded, focus: before.focus }).length === 0,
        'the open basis and the keyboard focus survive an unattended refresh',
        { before, after });
      // The refresh is a read of the snapshot. It must not be presented as a new provider read,
      // and the announced next direct read must not move because the page redrew.
      const nextBefore = await evaluate('(() => {' +
        ' const a = [...document.querySelectorAll(".account")].find(el => el.querySelector(".account-name")?.textContent === "계정 1");' +
        ' return a?.querySelector(".direct-next")?.dataset.directNext ?? null; })()');
      const stillThere = await evaluate('(() => {' +
        ' const a = [...document.querySelectorAll(".account")].find(el => el.querySelector(".account-name")?.textContent === "계정 1");' +
        ' const d = a?.querySelector("details.account-details[open]");' +
        ' return { basis: Boolean(d?.querySelector(".measurement-origin")),' +
        '   next: a?.querySelector(".direct-next")?.dataset.directNext ?? null }; })()');
      check(stillThere?.basis === true,
        'the basis is still rendered after the refresh rather than collapsing back', stillThere);
      // Accepting "null or any string" would pass if the instant vanished or moved. It is the
      // collector's schedule, so redrawing the page must leave it exactly where it was.
      check(nextBefore !== null && stillThere?.next === nextBefore,
        'the announced next direct read is the same instant after the redraw, not a new one',
        { nextBefore, after: stillThere?.next });
    });


  } finally {
    await restoreAll();
    console.log('ui-flow: reached ' + reached + (stopAt ? ' (PARTIAL, stopped after ' + stopAt + ')' : '') +
      ' of ' + LAST);
  }
  return { reached, partial: Boolean(stopAt), stopped };
}

if (import.meta.main) {
  const failures: any[] = [];
  const checks: any[] = [];
  const expect = (condition: unknown, description: string, detail?: unknown) => {
    checks.push(description);
    if (!condition) failures.push(detail === undefined ? description : description + ' — ' + JSON.stringify(detail));
  };
  const snapshot = buildFixture();
  const page = await openDashboard({ snapshot, fail: message => failures.push(message) });
  let outcome: any = null;
  try {
    await page.settle('document.querySelectorAll(".summary-provider").length || 0');
    outcome = await regressionFlow({ page, snapshot, expect, screens: SCREENS });
    for (const problem of page.problems) failures.push(problem);
    expect(page.problems.length === 0, 'browser console stays clean', page.problems);
  } finally {
    await page.close();
  }
  if (failures.length) {
    console.error('ui-flow failed (' + failures.length + ' of ' + checks.length + '):');
    for (const failure of failures) console.error('  - ' + failure);
    process.exit(1);
  }
  // A run that stopped early checked less than the route promises, so it must not read as a
  // pass anywhere it could be quoted from.
  if (outcome?.partial) {
    console.error('ui-flow PARTIAL: stopped after ' + process.env.QUOTA_UI_FLOW_STOP +
      ', ' + checks.length + ' of the route\'s assertions ran. This is not a pass.');
    process.exit(1);
  }
  console.log('ui-flow passed: ' + checks.length + ' assertions');
  console.log('ui-flow screens: ' + join(SCREENS, 'flow'));
}
