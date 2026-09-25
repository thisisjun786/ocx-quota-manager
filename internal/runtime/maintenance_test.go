package runtime

import (
	"errors"
	"testing"
	"time"
)

type memMaintainer struct {
	meta  map[string]any
	calls []int64
	err   error
}

func (m *memMaintainer) Meta(key string) (any, bool) {
	v, ok := m.meta[key]
	return v, ok
}

func (m *memMaintainer) SetMeta(key string, value any) error {
	if m.meta == nil {
		m.meta = map[string]any{}
	}
	if value == nil {
		delete(m.meta, key)
		return nil
	}
	m.meta[key] = value
	return nil
}

func (m *memMaintainer) Maintain(now int64) error {
	m.calls = append(m.calls, now)
	return m.err
}

func TestMaintainFirstRunThenDaily(t *testing.T) {
	m := &memMaintainer{}
	start := time.UnixMilli(1_800_000_000_000).UTC()
	if err := MaintainIfDue(m, start); err != nil {
		t.Fatal(err)
	}
	if len(m.calls) != 1 {
		t.Fatalf("first cycle must maintain: %v", m.calls)
	}
	if err := MaintainIfDue(m, start.Add(23*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if len(m.calls) != 1 {
		t.Fatalf("same day must not repeat: %v", m.calls)
	}
	if err := MaintainIfDue(m, start.Add(24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if len(m.calls) != 2 || m.calls[1] != start.Add(24*time.Hour).UnixMilli() {
		t.Fatalf("next day: %v", m.calls)
	}
}

func TestMaintainRetriesAfterClockRollbackAndFailure(t *testing.T) {
	m := &memMaintainer{}
	start := time.UnixMilli(1_800_000_000_000).UTC()
	if err := MaintainIfDue(m, start); err != nil {
		t.Fatal(err)
	}
	if err := MaintainIfDue(m, start.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if len(m.calls) != 2 {
		t.Fatalf("clock rollback must retry: %v", m.calls)
	}
	m.err = errors.New("disk")
	if err := MaintainIfDue(m, start.Add(24*time.Hour)); err == nil {
		t.Fatal("failure must propagate")
	}
	if _, ok := m.Meta(maintenanceFailedKey); !ok {
		t.Fatal("failure stamp missing")
	}
	m.err = nil
	soon := start.Add(24*time.Hour + time.Minute)
	if err := MaintainIfDue(m, soon); err != nil {
		t.Fatal(err)
	}
	if len(m.calls) != 4 {
		t.Fatalf("failed attempt must retry next cycle: %v", m.calls)
	}
	if _, ok := m.Meta(maintenanceFailedKey); ok {
		t.Fatal("success must clear the failure stamp")
	}
}

func TestMaintainSkipsStoresWithoutRetention(t *testing.T) {
	if err := MaintainIfDue(struct{}{}, time.UnixMilli(1)); err != nil {
		t.Fatal(err)
	}
	if err := MaintainIfDue(nil, time.UnixMilli(1)); err != nil {
		t.Fatal(err)
	}
}
