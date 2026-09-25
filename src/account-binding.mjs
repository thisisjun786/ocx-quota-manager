// Which physical account an observation belongs to, kept separate from the public account id.
// A token refresh keeps the boundary; replacing the physical account, organisation or key
// starts a new one. History is never re-attributed across that line.
export const EPOCH_REASONS = ['initial', 'physical_changed', 'basis_changed',
  'restart_unverifiable', 'deleted', 'removed'];
// The observation namespace a retired boundary invalidates. Closing an epoch without
// dropping its cached reading would let the previous account's numbers reappear under the
// replacement, so the default purge covers it rather than relying on the caller.
export const DIRECT_QUOTA_PREFIX = 'directQuotaV1';

export function createBindingRegistry({ store, now = Date.now,
  purgeKeys = (provider, account) => [`${DIRECT_QUOTA_PREFIX}:${provider}:${account}`] }) {
  // Physical identifiers that must not be persisted are compared here instead. The table is
  // empty after a restart, which is exactly why identity is then unverifiable rather than
  // assumed unchanged.
  const volatile = new Map();
  const purge = (provider, account) => {
    for (const key of purgeKeys(provider, account)) {
      store.db.prepare('DELETE FROM meta WHERE key=?').run(key);
    }
  };

  // Close the current boundary and drop the observations it vouched for. A retired epoch has
  // no evidence left, so keeping its cached reading would let it reappear under a new account.
  function retire(binding, reason) {
    const { provider, accountId } = binding;
    volatile.delete(binding.key);
    if (!store.epochs.current(provider, accountId)) return null;
    store.transact(() => {
      store.epochs.close(provider, accountId, now(), reason);
      purge(provider, accountId);
    });
    return null;
  }

  function resolve(binding) {
    const { provider, accountId, physical } = binding;
    if (binding.deleted) return retire(binding, 'deleted');
    const current = store.epochs.current(provider, accountId);
    const start = reason => {
      const opened = store.transact(() => {
        purge(provider, accountId);
        return store.epochs.open(provider, accountId, physical, now(), reason);
      });
      volatile.set(binding.key, physical.digest ?? null);
      return { epoch: opened.epoch, changed: true, reason };
    };
    if (!current) return start('initial');
    // A different kind of evidence cannot be compared with the old kind, so sameness
    // cannot be claimed.
    if (current.basis !== physical.basis) return start('basis_changed');
    if (physical.storable) {
      // Storable evidence survives a restart, so the boundary is restored rather than reopened.
      if (current.physicalDigest !== physical.digest) return start('physical_changed');
      volatile.set(binding.key, physical.digest ?? null);
      return { epoch: current.epoch, changed: false, reason: current.reason };
    }
    // Unstorable evidence is only comparable within this process.
    if (!volatile.has(binding.key)) return start('restart_unverifiable');
    if (volatile.get(binding.key) !== (physical.digest ?? null)) return start('physical_changed');
    return { epoch: current.epoch, changed: false, reason: current.reason };
  }

  return { resolve, retire };
}
