package collect

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/thisisjun786/ocx-quota-manager/internal/transport"
)

var errRedirect = errors.New("redirect refused")

const maxBody = 8 << 20

// HTTPSTransport talks only to a fixed host/path. Redirects are errors.
type HTTPSTransport struct {
	Client *http.Client
}

func NewHTTPSTransport() *HTTPSTransport {
	t := &HTTPSTransport{}
	t.Client = &http.Client{
		Timeout: 8 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errRedirect
		},
	}
	return t
}

func (t *HTTPSTransport) Do(ctx context.Context, req transport.Request) (transport.Response, error) {
	if req.Host == "" || strings.ContainsAny(req.Host, "/\\") {
		return transport.Response{}, errors.New("fixed host required")
	}
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodPost {
		return transport.Response{}, errors.New("read-only methods only")
	}
	timeout := req.Timeout
	if timeout == 0 {
		timeout = 8 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	url := "https://" + req.Host + req.Path
	httpReq, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(req.Body))
	if err != nil {
		return transport.Response{}, err
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	res, err := t.Client.Do(httpReq)
	if err != nil {
		return transport.Response{}, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil {
		return transport.Response{}, err
	}
	if len(body) > maxBody {
		return transport.Response{}, errors.New("response too large")
	}
	return transport.Response{Status: res.StatusCode, Headers: res.Header, Body: body}, nil
}

// Fake records requests and returns scripted responses. No network.
// HostResponses / HostErrors win over sequential Responses so concurrent
// Collect can key a failure to one provider without racing call order.
type Fake struct {
	mu            sync.Mutex
	Responses     []transport.Response
	HostResponses map[string]transport.Response
	HostErrors    map[string]error
	Calls         []transport.Request
	Delay         time.Duration
	Err           error
}

func (f *Fake) Do(ctx context.Context, req transport.Request) (transport.Response, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, req)
	n := len(f.Calls)
	hostErr, hasHostErr := f.HostErrors[req.Host]
	hostRes, hasHostRes := f.HostResponses[req.Host]
	f.mu.Unlock()
	if f.Delay > 0 {
		select {
		case <-ctx.Done():
			return transport.Response{}, ctx.Err()
		case <-time.After(f.Delay):
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if hasHostErr {
		return transport.Response{}, hostErr
	}
	if hasHostRes {
		return hostRes, nil
	}
	if f.Err != nil {
		return transport.Response{}, f.Err
	}
	if len(f.Responses) == 0 {
		return transport.Response{Status: 200, Body: []byte(`{}`)}, nil
	}
	if n <= len(f.Responses) {
		return f.Responses[n-1], nil
	}
	return f.Responses[len(f.Responses)-1], nil
}

func (f *Fake) CallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.Calls)
}

func (f *Fake) SetHost(host string, res transport.Response, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.HostResponses == nil {
		f.HostResponses = map[string]transport.Response{}
	}
	if f.HostErrors == nil {
		f.HostErrors = map[string]error{}
	}
	if err != nil {
		f.HostErrors[host] = err
		delete(f.HostResponses, host)
		return
	}
	delete(f.HostErrors, host)
	f.HostResponses[host] = res
}
