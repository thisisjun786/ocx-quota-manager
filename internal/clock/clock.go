package clock

import (
	"sync"
	"time"
)

// Clock is the only time source collection and calculation may use.
// Tests inject a fake. There is no plugin registry.
type Clock interface {
	Now() time.Time
}

type System struct{}

func (System) Now() time.Time { return time.Now().UTC() }

type Fixed struct{ T time.Time }

func (f Fixed) Now() time.Time { return f.T }

type Scripted struct {
	Times []time.Time
	i     int
}

func (s *Scripted) Now() time.Time {
	if len(s.Times) == 0 {
		return time.Time{}
	}
	if s.i >= len(s.Times) {
		return s.Times[len(s.Times)-1]
	}
	t := s.Times[s.i]
	s.i++
	return t
}

// Var is a test clock that can be moved forward without replacing the Runtime.
type Var struct {
	mu sync.Mutex
	T  time.Time
}

func (c *Var) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.T
}

func (c *Var) Set(t time.Time) {
	c.mu.Lock()
	c.T = t
	c.mu.Unlock()
}
