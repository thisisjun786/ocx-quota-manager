package transport

import (
	"context"
	"io"
	"net/http"
	"time"
)

// Request is a fixed-destination HTTPS call. Adapters never build arbitrary URLs.
type Request struct {
	Host    string
	Path    string
	Method  string
	Headers map[string]string
	Body    []byte
	Timeout time.Duration
}

type Response struct {
	Status  int
	Headers http.Header
	Body    []byte
}

// Transport is the only outbound I/O seam. Tests inject a fake.
// Implementations must refuse redirects and honor context cancel.
type Transport interface {
	Do(ctx context.Context, req Request) (Response, error)
}

// Store is declared next to Transport so JUN-260 locks the I/O boundary
// without a plugin runtime. The SQLite implementation arrives in JUN-261.
type UnusedReader interface {
	ReadCloser() io.ReadCloser
}
