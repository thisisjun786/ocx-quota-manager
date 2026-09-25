import { modelId, carriesSecret, MODEL_EXCLUSIONS } from './snapshot.mjs';
import { iso } from './time.mjs';

// One durable record of which models this installation has offered, kept beside the
// history it already stores. A list read once says what exists now; only a retained
// previous list can say what appeared and what went away.
const KEY = 'modelRosterV1';
const CHANGE_LIMIT = 100;
const PUBLISHED_CHANGES = 20;

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Model names come from another product's files, and "toString" is a valid model id.
// Every name-keyed map is prototype-free so that a name can never resolve to a function
// inherited from Object and take the whole reading down with it.
const bare = () => Object.create(null);
const instant = value => Number.isFinite(value) && value > 0 ? value : null;
const counter = value => Number.isInteger(value) && value >= 0 ? value : 0;
const SOURCES = ['ocx-config', 'observed'];
const CHANGES = ['added', 'removed', 'returned', 'observed'];

// Stored state is rebuilt field by field. A hand-edited or half-written value must not
// reach the response, and a shape we do not recognize costs a new baseline rather than
// an exception inside the collection loop.
function normalizeModel(value) {
  if (!plain(value)) return null;
  const firstSeenAt = instant(value.firstSeenAt);
  const sources = SOURCES.filter(source => Array.isArray(value.sources) && value.sources.includes(source));
  if (firstSeenAt === null || !sources.length) return null;
  return { firstSeenAt, lastListedAt: instant(value.lastListedAt), lastObservedAt: instant(value.lastObservedAt),
    removedAt: instant(value.removedAt), listed: value.listed === true, sources };
}

function normalizeProvider(value) {
  if (!plain(value)) return null;
  const baselineAt = instant(value.baselineAt);
  if (baselineAt === null) return null;
  const models = bare();
  if (plain(value.models)) {
    for (const [id, model] of Object.entries(value.models)) {
      const next = modelId(id) === null ? null : normalizeModel(model);
      if (next) models[id] = next;
    }
  }
  const changes = (Array.isArray(value.changes) ? value.changes : []).flatMap(change =>
    plain(change) && instant(change.at) !== null && typeof change.model === 'string' && CHANGES.includes(change.change)
      ? [{ at: change.at, model: change.model, change: change.change }] : []).slice(-CHANGE_LIMIT);
  return { baselineAt, baselined: value.baselined === true, listedReadings: counter(value.listedReadings),
    seenAt: instant(value.seenAt), listedAt: instant(value.listedAt), suspectSince: instant(value.suspectSince),
    models, changes };
}

function normalizeState(value) {
  const providers = bare();
  if (plain(value) && plain(value.providers)) {
    for (const [id, provider] of Object.entries(value.providers)) {
      const next = normalizeProvider(provider);
      if (next) providers[id] = next;
    }
  }
  return { lastAttemptAt: instant(value?.lastAttemptAt), lastSuccessAt: instant(value?.lastSuccessAt),
    failureSince: instant(value?.failureSince), providers };
}

export function createModelRoster({ store, now = Date.now, changeLimit = CHANGE_LIMIT } = {}) {
  // The roster never breaks collection. Its own failures are reported as its own status
  // and never raised into the caller, because one bad stored value here must not turn
  // every quota reading on the page stale. A failure anywhere in a cycle stands until the
  // next clean one: a successful write does not clear a failed read.
  let broken = false;
  const load = () => { try { return normalizeState(store.get(KEY)); } catch { broken = true; return normalizeState(null); } };
  const save = state => { try { store.set(KEY, state); } catch { broken = true; } };

  // The oldest instant history still holds complete records for. It is the only safe
  // basis for forgetting anything: a model the usage log can still produce would be
  // rediscovered on the next reading as new, repeating the same change forever.
  const forgetBefore = () => { try { return instant(store.get('usageExcludedBefore')) ?? 0; } catch { broken = true; return 0; } };

  // Returns null when the lookup failed. An absent answer and an empty answer mean
  // opposite things here: only a reading that actually ran is evidence about what the
  // usage log still holds.
  const observedNames = (provider, at) => {
    try {
      const since = (store.bounds().since ?? 0) - 1;
      return store.observedModels(provider, since, at).map(row => row.model);
    } catch { broken = true; return null; }
  };

  // A name reaches the roster through the same gate as the price list: a model id by
  // shape, and never a value the configuration holds as a credential. The same filter
  // runs again on publication, so a name that becomes a key later is withheld even
  // though it was admitted when it was recorded.
  const admit = (names, excluded) => [...new Set((Array.isArray(names) ? names : []).filter(name =>
    typeof name === 'string' && modelId(name) !== null && !carriesSecret(name, excluded)))];

  const note = (entry, at, model, change) => {
    entry.changes.push({ at, model, change });
    if (entry.changes.length > changeLimit) entry.changes = entry.changes.slice(-changeLimit);
  };

  const source = (model, name) => {
    if (!model.sources.includes(name)) model.sources = SOURCES.filter(id => id === name || model.sources.includes(id));
  };

  // The listed set is the configured one. A model that leaves it keeps its identity, its
  // first sighting and its history; only its listing ends.
  function applyListed(entry, listed, at, baseline) {
    const current = new Set(listed);
    for (const name of listed) {
      const known = entry.models[name];
      if (!known) {
        entry.models[name] = { firstSeenAt: at, lastListedAt: at, lastObservedAt: null, removedAt: null,
          listed: true, sources: ['ocx-config'] };
        if (!baseline) note(entry, at, name, 'added');
        continue;
      }
      if (!known.listed && !baseline) note(entry, at, name, known.removedAt === null ? 'added' : 'returned');
      known.listed = true;
      known.lastListedAt = at;
      known.removedAt = null;
      source(known, 'ocx-config');
    }
    for (const [name, known] of Object.entries(entry.models)) {
      if (!known.listed || current.has(name)) continue;
      known.listed = false;
      known.removedAt = at;
      if (!baseline) note(entry, at, name, 'removed');
    }
  }

  // Usage is separate evidence. A model recorded only in the log is managed like any
  // other and never receives a removal: retention deletion and a history reset both
  // shrink the observed set without anything leaving the installation.
  function applyObserved(entry, observed, at, baseline) {
    for (const name of observed) {
      const known = entry.models[name];
      if (!known) {
        entry.models[name] = { firstSeenAt: at, lastListedAt: null, lastObservedAt: at, removedAt: null,
          listed: false, sources: ['observed'] };
        if (!baseline) note(entry, at, name, 'observed');
        continue;
      }
      known.lastObservedAt = at;
      source(known, 'observed');
    }
  }

  function applyProvider(state, id, provider, excluded, at, before) {
    const entry = state.providers[id] ??= { baselineAt: at, baselined: false, listedReadings: 0,
      seenAt: null, listedAt: null, suspectSince: null, models: bare(), changes: [] };
    // Two baselines, because they answer different questions. The provider's first
    // reading settles what usage has already recorded; its first reading that actually
    // lists models settles the comparison basis. An empty first reading must not become a
    // basis, or the next usable one reports the whole configuration as new.
    const firstReading = entry.seenAt === null;
    const listedBaseline = !entry.baselined;
    entry.seenAt = at;
    const listed = admit(provider.supportedModels, excluded);
    const held = Object.entries(entry.models).filter(([, model]) => model.listed).map(([name]) => name);
    // A caller that verified the list is believed as it stands. Nobody sets this yet; the
    // contract for it belongs to the configuration-read owner.
    const verified = provider.modelListStatus === 'ok';
    // What a models field that failed to parse projects to, exactly: nothing, or nothing
    // but the default selector, which is validated separately. A reading of that shape
    // that would drop a model is not evidence that the model went away.
    const degenerate = !listed.length || (listed.length === 1 && listed[0] === provider.defaultModel);
    const drops = held.some(name => !listed.includes(name));
    if (provider.modelListStatus === 'unreadable' || (drops && degenerate && !verified)) {
      entry.suspectSince ??= at;
    } else {
      entry.suspectSince = null;
      entry.listedAt = at;
      if (listed.length) {
        entry.baselined = true;
        entry.listedReadings += 1;
        applyListed(entry, listed, at, listedBaseline);
      } else if (entry.baselined) {
        entry.listedReadings += 1;
        applyListed(entry, [], at, false);
      }
    }
    const names = observedNames(id, at);
    applyObserved(entry, admit(names, excluded), at, firstReading);
    if (names !== null) prune(entry, new Set(names), before);
  }

  // One rule for forgetting, and it is the only safe one: drop a model the configuration
  // no longer lists once a lookup that actually ran shows the usage log no longer holds
  // it, and its last activity is older than the completeness boundary. Anything still
  // reachable by either source would come back on the next reading as a new model, with a
  // new first sighting and a repeated change, so a failed lookup and an absent provider
  // forget nothing at all.
  function prune(entry, seen, before) {
    if (!before) return;
    for (const [name, model] of Object.entries(entry.models)) {
      if (model.listed || seen.has(name)) continue;
      const last = Math.max(model.lastObservedAt ?? 0, model.removedAt ?? 0, model.lastListedAt ?? 0, model.firstSeenAt);
      if (last < before) delete entry.models[name];
    }
  }

  const providerStatus = (state, entry) =>
    entry.seenAt !== state.lastSuccessAt ? 'absent'
      : !entry.baselined ? 'unknown'
        : entry.suspectSince !== null ? 'suspect'
          : entry.listedReadings <= 1 ? 'baseline' : 'ok';

  function describe(state, id, excluded) {
    const entry = state.providers[id];
    if (!entry) return { status: 'unknown', baselineAt: null, listedAt: null, suspectSince: null,
      listedCount: 0, knownCount: 0, models: [], changes: [] };
    const publishable = name => modelId(name) !== null && !carriesSecret(name, excluded);
    const models = Object.entries(entry.models).filter(([name]) => publishable(name))
      .map(([name, model]) => ({ model: name,
        state: model.listed ? 'listed' : model.removedAt === null ? 'observed-only' : 'removed',
        sources: [...model.sources], firstSeenAt: iso(model.firstSeenAt), lastListedAt: iso(model.lastListedAt),
        lastObservedAt: iso(model.lastObservedAt), removedAt: iso(model.removedAt) }))
      .sort((a, b) => a.model.localeCompare(b.model));
    const changes = entry.changes.filter(change => publishable(change.model)).slice(-PUBLISHED_CHANGES).reverse()
      .map(change => ({ at: iso(change.at), model: change.model, change: change.change }));
    return { status: providerStatus(state, entry), baselineAt: iso(entry.baselineAt), listedAt: iso(entry.listedAt),
      suspectSince: iso(entry.suspectSince), listedCount: models.filter(model => model.state === 'listed').length,
      knownCount: models.length, models, changes };
  }

  return {
    // One reading of the configured lists, taken from the snapshot the collector just
    // read rather than by reading the configuration a second time.
    record(snapshot, at = now()) {
      broken = false;
      try {
        const state = load();
        const stamp = instant(at) ?? now();
        state.lastAttemptAt = stamp;
        state.lastSuccessAt = stamp;
        state.failureSince = null;
        const excluded = snapshot?.[MODEL_EXCLUSIONS];
        const before = forgetBefore();
        for (const provider of Array.isArray(snapshot?.providers) ? snapshot.providers : []) {
          if (typeof provider?.id !== 'string' || !provider.id.length) continue;
          applyProvider(state, provider.id, provider, excluded, stamp, before);
        }
        save(state);
      } catch { broken = true; }
    },
    // A cycle that never produced a list. The previous list, its models and the instant it
    // was read all stay exactly as they were; only the failure is new.
    fail(at = now()) {
      broken = false;
      try {
        const state = load();
        const stamp = instant(at) ?? now();
        state.lastAttemptAt = stamp;
        state.failureSince ??= stamp;
        save(state);
      } catch { broken = true; }
    },
    enrich(snapshot, excluded) {
      const state = load();
      for (const provider of snapshot.providers) {
        try { provider.analytics.modelRoster = describe(state, provider.id, excluded); }
        catch { broken = true; provider.analytics.modelRoster = describe(normalizeState(null), provider.id, excluded); }
      }
      const present = new Set(snapshot.providers.map(provider => provider.id));
      const absent = Object.entries(state.providers)
        .filter(([id, entry]) => !present.has(id) || entry.seenAt !== state.lastSuccessAt)
        // A provider id left the configuration, so it passes the same gate a model name
        // does before being republished from stored state.
        .map(([id]) => id).filter(id => modelId(id) !== null && !carriesSecret(id, excluded)).sort();
      snapshot.analytics.modelRoster = {
        status: broken ? 'error' : state.failureSince !== null ? 'failed'
          : state.lastSuccessAt === null ? 'collecting' : 'ok',
        lastAttemptAt: iso(state.lastAttemptAt), lastSuccessAt: iso(state.lastSuccessAt),
        failureSince: iso(state.failureSince), absentProviders: absent };
      return snapshot;
    },
  };
}
