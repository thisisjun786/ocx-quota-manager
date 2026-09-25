package runtime

import "time"

// maintainer is the optional daily retention surface. Stores that do not
// implement it are left alone.
type maintainer interface {
	Maintain(now int64) error
	Meta(key string) (any, bool)
	SetMeta(key string, value any) error
}

const (
	maintenanceAtKey     = "maintenanceAt"
	maintenanceFailedKey = "maintenanceFailedAt"
	maintenanceDay       = int64(24 * time.Hour / time.Millisecond)
)

// MaintainIfDue runs retention on the first cycle, then once per elapsed day.
// Call it after usage ingestion and before analysis. Retention drops price
// evidence that nothing links yet, so running it first would delete evidence
// the ingest just stored for the rows it is about to price. A backward clock
// or a failed attempt retries on the next cycle. The error is returned for
// the existing analysis-failure path.
//
//	if err := MaintainIfDue(rt.Store, now); err != nil { mark the cycle failed }
func MaintainIfDue(store any, now time.Time) error {
	m, ok := store.(maintainer)
	if !ok || m == nil {
		return nil
	}
	nowMS := now.UTC().UnixMilli()
	if !maintenanceDue(m, nowMS) {
		return nil
	}
	if err := m.Maintain(nowMS); err != nil {
		_ = m.SetMeta(maintenanceFailedKey, nowMS)
		return err
	}
	if err := m.SetMeta(maintenanceAtKey, nowMS); err != nil {
		return err
	}
	return m.SetMeta(maintenanceFailedKey, nil)
}

func maintenanceDue(m maintainer, nowMS int64) bool {
	if failed, ok := metaMillis(m, maintenanceFailedKey); ok && failed > 0 {
		return true
	}
	last, ok := metaMillis(m, maintenanceAtKey)
	if !ok {
		return true
	}
	if nowMS < last {
		return true
	}
	return nowMS-last >= maintenanceDay
}

func metaMillis(m interface{ Meta(string) (any, bool) }, key string) (int64, bool) {
	v, ok := m.Meta(key)
	if !ok || v == nil {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		return int64(n), true
	case int64:
		return n, true
	case int:
		return int64(n), true
	default:
		return 0, false
	}
}
