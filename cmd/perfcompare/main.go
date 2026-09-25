package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/clock"
	"github.com/thisisjun786/ocx-quota-manager/internal/collect"
	"github.com/thisisjun786/ocx-quota-manager/internal/contract"
	"github.com/thisisjun786/ocx-quota-manager/internal/httpserver"
	rt "github.com/thisisjun786/ocx-quota-manager/internal/runtime"
	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
	"github.com/thisisjun786/ocx-quota-manager/webembed"
)

// Bar locked in JUN-259. A miss is reported, never hidden.
type Bar struct {
	Repeats              int     `json:"repeats"`
	DropWorst            int     `json:"dropWorst"`
	IdleRSSImprovePct    float64 `json:"idleRssImprovePct"`
	CollectWallImprovePct float64 `json:"collectWallImprovePct"`
	OtherImprovePct      float64 `json:"otherImprovePct"`
	NoExtraExternalReqs  bool    `json:"noExtraExternalRequests"`
}

type Report struct {
	Repeats           int      `json:"repeats"`
	SnapshotP50Ms     float64  `json:"snapshotP50Ms"`
	SnapshotP95Ms     float64  `json:"snapshotP95Ms"`
	ColdStartMs       float64  `json:"coldStartMs"`
	AllocBytes        uint64   `json:"allocBytes"`
	RssKB             int64    `json:"rssKb"`
	ExternalCalls     int      `json:"externalCalls"`
	HTTPGets          int      `json:"httpGets"`
	CollectStarted    bool     `json:"collectStarted"`
	MeasurementFailed bool     `json:"measurementFailed"`
	MissHidden        bool     `json:"missHidden"`
	Notes             []string `json:"notes"`
}

func main() {
	bar := Bar{Repeats: 7, DropWorst: 2, IdleRSSImprovePct: 15, CollectWallImprovePct: 15, OtherImprovePct: 5, NoExtraExternalReqs: true}
	rep := measure(bar)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(rep)
	if rep.MissHidden || rep.MeasurementFailed {
		fmt.Fprintln(os.Stderr, "perfcompare measurement failed; refusing to exit 0")
		os.Exit(1)
	}
}

func failedReport(note string) Report {
	return Report{MissHidden: true, MeasurementFailed: true, Notes: []string{note}}
}

func measure(bar Bar) Report {
	// Bar is locked by the caller. Do not adjust repeats or thresholds from the numbers below.
	fake := &collect.Fake{Responses: []transport.Response{{Status: 200, Body: []byte(`{"plans":[]}`)}}}
	clk := clock.System{}
	start := time.Now()
	app := rt.New(clk, nil, fake)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	app.Start(ctx)
	// AllowedBind rejects port 0, so grab a free unprivileged port from the
	// kernel and close the placeholder listener before handing it over. A fixed
	// port here would silently pass while another process holds it.
	placeholder, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return failedReport("ephemeral port grab failed: " + err.Error())
	}
	_, portText, _ := net.SplitHostPort(placeholder.Addr().String())
	port, _ := strconv.Atoi(portText)
	placeholder.Close()
	s, err := httpserver.New(httpserver.Options{
		Host: "127.0.0.1", Port: port, Public: webembed.FS(), Snapshot: app.Snapshot,
	})
	if err != nil {
		return failedReport(err.Error())
	}
	if err := s.Listen(); err != nil {
		return failedReport(err.Error())
	}
	defer s.Close()
	cold := time.Since(start).Seconds() * 1000
	var samples []float64
	httpGets := 0
	for i := 0; i < bar.Repeats; i++ {
		t0 := time.Now()
		res, err := http.Get("http://" + s.Addr() + "/api/v1/snapshot")
		httpGets++
		if err != nil {
			return failedReport("snapshot request failed: " + err.Error())
		}
		if res.StatusCode != http.StatusOK {
			res.Body.Close()
			return failedReport(fmt.Sprintf("snapshot request returned %d", res.StatusCode))
		}
		res.Body.Close()
		samples = append(samples, time.Since(t0).Seconds()*1000)
	}
	sort.Float64s(samples)
	kept := samples
	if len(kept) > bar.DropWorst {
		kept = kept[:len(kept)-bar.DropWorst]
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	callsBefore := fake.CallCount()
	for i := 0; i < 3; i++ {
		res, err := http.Get("http://" + s.Addr() + "/api/v1/snapshot")
		if err == nil {
			res.Body.Close()
			httpGets++
		} else {
			return failedReport("refresh request failed: " + err.Error())
		}
	}
	rep := Report{
		Repeats:        bar.Repeats,
		SnapshotP50Ms:  percentile(kept, 0.50),
		SnapshotP95Ms:  percentile(samples, 0.95),
		ColdStartMs:    cold,
		AllocBytes:     ms.Alloc,
		RssKB:          rssKB(),
		ExternalCalls:  fake.CallCount(),
		HTTPGets:       httpGets,
		CollectStarted: true,
		// A completed measurement is the opposite of a hidden miss.
		MeasurementFailed: false,
		MissHidden:     false,
		Notes: []string{
			"AllocBytes is Go heap, not process RSS. rssKb is /proc/self/status VmRSS.",
			"This isolated helper has no Node baseline. npm run check:port:integrate owns the 15% idle-RSS bar.",
			"HTTP GETs must not increase collect transport calls",
		},
	}
	if fake.CallCount() != callsBefore {
		rep.Notes = append(rep.Notes, "HTTP refresh increased transport calls")
	}
	if rep.ExternalCalls > 0 && rep.HTTPGets > 0 && rep.ExternalCalls > rep.HTTPGets {
		rep.Notes = append(rep.Notes, "external calls exceeded HTTP gets")
	}
	_ = contract.SchemaVersion
	return rep
}

func rssKB() int64 {
	raw, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				n, _ := strconv.ParseInt(fields[1], 10, 64)
				return n
			}
		}
	}
	return 0
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(float64(len(sorted)-1) * p)
	if i < 0 {
		i = 0
	}
	if i >= len(sorted) {
		i = len(sorted) - 1
	}
	return sorted[i]
}
