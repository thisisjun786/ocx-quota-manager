package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"time"
)

type epochStore interface {
	EpochForIdentity(string, string, string, *string, int64) (int64, error)
}
type runtimeIdentity struct {
	key   string
	epoch int64
}

func (rt *Runtime) bindingEpochs(bindings []collect.Binding, now int64) (map[string]int64, error) {
	out := map[string]int64{}
	st, ok := rt.Store.(epochStore)
	if !ok {
		return out, nil
	}
	if rt.identities == nil {
		rt.identities = map[string]runtimeIdentity{}
	}
	seen := map[string]int{}
	for _, b := range bindings {
		seen[b.Provider+"\x00"+b.AccountID]++
	}
	active := map[string]runtimeIdentity{}
	for _, b := range bindings {
		key := b.Provider + "\x00" + b.AccountID
		if b.Token == "" || seen[key] != 1 {
			continue
		}
		basis := "key_material"
		var digest *string
		identity := b.Token
		if b.AccountRef != nil && *b.AccountRef != "" {
			basis = "credential_account_id"
			if b.Provider == "openai" {
				basis = "chatgpt_account_id"
				if b.AccountID == "__main__" {
					basis = "native_account_id"
				}
			}
			hash := sha256.Sum256([]byte("qm-epoch-v1\x00" + *b.AccountRef))
			value := hex.EncodeToString(hash[:])
			digest = &value
			identity = value
		}
		// Token-derived comparison stays in process memory, never in SQLite or JSON.
		hash := sha256.Sum256([]byte(basis + "\x00" + identity))
		comparison := hex.EncodeToString(hash[:])
		old, exists := rt.identities[key]
		if !exists || old.key != comparison {
			epoch, err := st.EpochForIdentity(b.Provider, b.AccountID, basis, digest, now)
			if err != nil {
				return nil, err
			}
			old = runtimeIdentity{comparison, epoch}
			rt.identities[key] = old
		}
		active[key] = old
		out[key] = old.epoch
	}
	rt.identities = active
	return out, nil
}
func applyReadingEpochs(providers []contract.Provider, rows []collect.Reading, epochs map[string]int64) {
	for pi := range providers {
		p := &providers[pi]
		for ai := range p.Accounts {
			a := &p.Accounts[ai]
			for wi := range a.Windows {
				w := &a.Windows[wi]
				for _, r := range rows {
					if r.Provider != p.ID || r.Account != a.ID || r.WindowID != w.ID || (r.Kind != collect.WindowOK && r.Kind != collect.WindowFailed) || r.RemainingPercent == nil || w.RemainingPercent == nil || *r.RemainingPercent != *w.RemainingPercent {
						continue
					}
					if a.UpdatedAt == nil {
						continue
					}
					at, err := time.Parse(time.RFC3339Nano, *a.UpdatedAt)
					if err != nil || at.UnixMilli() != r.ObservedAt {
						continue
					}
					if (r.ResetAt == nil) != (w.ResetAt == nil) {
						continue
					}
					if r.ResetAt != nil {
						reset, err := time.Parse(time.RFC3339Nano, *w.ResetAt)
						if err != nil || reset.UnixMilli() != *r.ResetAt {
							continue
						}
					}
					if e, ok := epochs[p.ID+"\x00"+a.ID]; ok {
						v := e
						w.IdentityEpoch = &v
					}
				}
			}
		}
	}
}
