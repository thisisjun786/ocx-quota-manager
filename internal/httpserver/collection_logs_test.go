package httpserver

import (
	"encoding/json"
	"net/http"
	"testing"
	"testing/fstest"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func TestCollectionLogsHTTPReadOnlyAndValidation(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	calls := 0
	s, err := New(Options{Host: "127.0.0.1", Port: 18799, Public: fstest.MapFS{"index.html": {Data: []byte("ok")}}, Snapshot: func() contract.Snapshot { return fixtureSnap() }, Now: func() time.Time { return now }, CollectionLogs: func(q store.CollectionLogQuery) (store.CollectionLogsPage, error) {
		calls++
		return store.CollectionLogsPage{Period: q.Period, From: q.Now - 86400000, To: q.Now, RetentionDays: 30, Rows: []store.CollectionLog{}, Summary: []store.CollectionLogSummary{}, Providers: []string{}, Accounts: []store.CollectionLogAccount{}}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	for _, path := range []string{"?period=8d", "?period=", "?result=", "?result=wrong", "?before=0", "?before=-1", "?before=abc", "?provider=a&provider=b"} {
		res := get(t, s, "/api/v1/collection-logs"+path, nil)
		res.Body.Close()
		if res.StatusCode != 400 {
			t.Fatalf("%s: %d", path, res.StatusCode)
		}
	}
	if calls != 0 {
		t.Fatalf("invalid input reached database: %d", calls)
	}
	res := get(t, s, "/api/v1/collection-logs", http.Header{"Origin": []string{"https://evil.example"}})
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("origin: %d", res.StatusCode)
	}
	res = get(t, s, "/api/v1/collection-logs?result=rate_limited&before=3", nil)
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("valid: %d", res.StatusCode)
	}
	var page store.CollectionLogsPage
	if err = json.NewDecoder(res.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || page.Period != "24h" || page.RetentionDays != 30 || page.Rows == nil || page.NextBefore != nil {
		t.Fatalf("page: %+v calls=%d", page, calls)
	}
}
