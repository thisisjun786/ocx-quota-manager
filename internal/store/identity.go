package store

import "database/sql"

// EpochForIdentity reuses only independently verified non-secret identity.
// Callers without a durable identity open a new epoch once per process.
func (h *History) EpochForIdentity(provider, account, basis string, digest *string, now int64) (int64, error) {
	if digest != nil {
		var epoch int64
		var oldBasis string
		var oldDigest *string
		err := h.db.QueryRow(`SELECT epoch,basis,physicalDigest FROM identity_epochs WHERE provider=? AND account=? AND endedAt IS NULL`, provider, account).Scan(&epoch, &oldBasis, &oldDigest)
		if err != nil && err != sql.ErrNoRows {
			return 0, err
		}
		if err == nil && oldBasis == basis && oldDigest != nil && *oldDigest == *digest {
			return epoch, nil
		}
	}
	return h.OpenEpoch(provider, account, basis, digest, now, "physical_changed")
}
