package runtime

import (
	"context"
	"errors"
	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
	"strings"
	"testing"
	"time"
)

type pressureStore struct {
	*store.History
	used, limit int64
	err         error
}

func (s *pressureStore) StorageUsage() (int64, int64, error) { return s.used, s.limit, s.err }

func TestStorageWarningsReachSnapshot(t *testing.T) {
	h := &pressureStore{History: openProbeStore(t), limit: 1000}
	rt := New(clock.Fixed{T: time.UnixMilli(1800000000000)}, h, &collect.Fake{})
	rt.Home = writeProbeHome(t, nil)
	for _, tc := range []struct {
		used     int64
		err      error
		expected string
	}{
		{799, nil, ""}, {800, nil, "80%"}, {1000, nil, "100%"}, {0, errors.New("private database path"), "확인하지 못했습니다"},
	} {
		h.used, h.err = tc.used, tc.err
		rt.cycle(context.Background())
		text := strings.Join(rt.Snapshot().Warnings, " ")
		if tc.expected == "" && strings.Contains(text, "DB") {
			t.Fatalf("unexpected warning: %s", text)
		}
		if tc.expected != "" && !strings.Contains(text, tc.expected) {
			t.Fatalf("missing %s: %s", tc.expected, text)
		}
		if strings.Contains(text, "private database path") {
			t.Fatal("private error leaked")
		}
	}
	if got := storageWarnings(struct{}{}); len(got) != 0 {
		t.Fatal(got)
	}
}
