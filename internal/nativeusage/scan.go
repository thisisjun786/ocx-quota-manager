package nativeusage

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const fileBudget = 2 << 20
const batchBudget = 16 << 20
const lineLimit = 8 << 20
const filesPerBatch = 64

type Cursor struct {
	Revision            int
	Offset, Size, MTime int64
	Visited             int64
	Head, Tail          string
	State               State
}

type Source struct {
	Client string
	Roots  []string
}
type Batch struct {
	Events                          []Event
	Cursors                         map[string]Cursor
	Files, Pending, Invalid, Failed int
	Bytes                           int64
	Present                         bool
}

type file struct {
	path string
	info fs.FileInfo
}

// Scan is bounded per source, and visits recently written files first. A busy
// file gets at most fileBudget bytes before yielding to siblings. Completed
// unchanged files are stat-only; cursors and parser state survive restart.
func Scan(ctx context.Context, source Source, previous map[string]Cursor, cutoff, now int64) (Batch, error) {
	b := Batch{Cursors: map[string]Cursor{}}
	var files []file
	for _, root := range source.Roots {
		if root == "" {
			continue
		}
		if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			b.Failed++
			continue
		}
		b.Present = true
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if walkErr != nil {
				b.Failed++
				if d != nil && d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.IsDir() || d.Type()&os.ModeSymlink != 0 {
				return nil
			}
			ext := ".jsonl"
			if source.Client == "antigravity" {
				ext = ".db"
			}
			if !strings.HasSuffix(d.Name(), ext) {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				b.Failed++
				return nil
			}
			if info.Mode().IsRegular() {
				files = append(files, file{path, info})
			}
			return nil
		})
		if err != nil {
			return b, err
		}
	}
	sort.Slice(files, func(i, j int) bool {
		// Least recently visited first: continuously appended large transcripts
		// cannot starve older files during a multi-cycle initial backfill.
		a := previous[Hash(source.Client, files[i].path)].Visited
		b := previous[Hash(source.Client, files[j].path)].Visited
		if a != b {
			return a < b
		}
		if files[i].info.ModTime().Equal(files[j].info.ModTime()) {
			return files[i].path < files[j].path
		}
		return files[i].info.ModTime().After(files[j].info.ModTime())
	})
	for _, f := range files {
		if err := ctx.Err(); err != nil {
			return b, err
		}
		key := Hash(source.Client, f.path)
		prev := previous[key]
		size, mtime := f.info.Size(), f.info.ModTime().UnixNano()
		if source.Client == "antigravity" {
			// A write may live entirely in WAL while the main DB stat is unchanged.
			if wal, err := os.Stat(f.path + "-wal"); err == nil {
				mtime ^= wal.ModTime().UnixNano()
				size += wal.Size()
			}
		}
		if prev.Revision == Revision && prev.Size == size && prev.MTime == mtime && prev.Offset >= f.info.Size() {
			continue
		}
		if b.Files >= filesPerBatch || b.Bytes >= batchBudget {
			b.Pending++
			continue
		}
		b.Files++
		// Failed attempts participate in the fair schedule too. Preserve their
		// last committed offset/state; an error must not advance source data.
		attempted := prev
		attempted.Visited = now
		b.Cursors[key] = attempted
		if source.Client == "antigravity" {
			events, invalid, err := ReadAntigravityWithDiagnostics(ctx, f.path)
			b.Invalid += invalid
			if err != nil {
				b.Failed++
				continue
			}
			for _, e := range events {
				if e.At >= cutoff && e.At <= now+60000 {
					b.Events = append(b.Events, e)
				}
			}
			b.Bytes += size
			b.Cursors[key] = Cursor{Revision: Revision, Offset: f.info.Size(), Size: size, MTime: mtime, Visited: now}
			continue
		}
		events, next, n, invalid, err := readJSONL(ctx, f, source.Client, prev, cutoff, now)
		if err != nil {
			b.Failed++
			continue
		}
		b.Bytes += n
		b.Invalid += invalid
		b.Events = append(b.Events, events...)
		b.Cursors[key] = next
		next.Visited = now
		b.Cursors[key] = next
		if next.Offset < f.info.Size() {
			b.Pending++
		}
	}
	return b, nil
}

func readJSONL(ctx context.Context, src file, client string, prev Cursor, cutoff, now int64) ([]Event, Cursor, int64, int, error) {
	f, err := os.Open(src.path)
	if err != nil {
		return nil, prev, 0, 0, err
	}
	defer f.Close()
	size := src.info.Size()
	head := fingerprint(f, 0, min(size, 64))
	next := prev
	if prev.Revision != Revision || prev.Offset > size || (prev.Offset == size && prev.MTime != src.info.ModTime().UnixNano()) || (prev.Offset > 0 && (prev.Head != head || prev.Tail != fingerprint(f, max(0, prev.Offset-64), min(prev.Offset, 64)))) {
		next = Cursor{Revision: Revision}
	}
	next.Head = head
	next.Size = size
	next.MTime = src.info.ModTime().UnixNano()
	if _, err = f.Seek(next.Offset, io.SeekStart); err != nil {
		return nil, prev, 0, 0, err
	}
	r := bufio.NewReaderSize(f, 64<<10)
	start := next.Offset
	invalid := 0
	var events []Event
	for next.Offset-start < fileBudget {
		if err = ctx.Err(); err != nil {
			return nil, prev, 0, 0, err
		}
		line, n, complete, over, err := readLine(ctx, r)
		if err != nil {
			return nil, prev, 0, 0, err
		}
		if !complete {
			break
		} // leave a trailing partial record for the next pass
		next.Offset += n
		if over {
			invalid++
			if client == "codex" {
				next.State.Model = "unknown"
				next.State.Total = nil
				next.State.Turn = ""
			}
			continue
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		parsed := ParseLine(client, line, &next.State)
		if parsed.Invalid {
			invalid++
			if client == "codex" {
				next.State.Model = "unknown"
				next.State.Total = nil
				next.State.Turn = ""
			}
			continue
		}
		if e := parsed.Event; e != nil && e.At >= cutoff && e.At <= now+60000 {
			events = append(events, *e)
		}
	}
	next.Tail = fingerprint(f, max(0, next.Offset-64), min(next.Offset, 64))
	return events, next, next.Offset - start, invalid, nil
}

func fingerprint(f *os.File, off, n int64) string {
	if n == 0 {
		return ""
	}
	b := make([]byte, n)
	read, _ := f.ReadAt(b, off)
	return Hash(string(b[:read]))
}

func readLine(ctx context.Context, r *bufio.Reader) ([]byte, int64, bool, bool, error) {
	var b []byte
	var n int64
	over := false
	for {
		if err := ctx.Err(); err != nil {
			return nil, n, false, over, err
		}
		part, err := r.ReadSlice('\n')
		n += int64(len(part))
		if n > lineLimit {
			over = true
			b = nil
		} else if !over {
			b = append(b, part...)
		}
		if err == nil {
			return b, n, true, over, nil
		}
		if err == io.EOF {
			return nil, n, false, over, nil
		}
		if err != bufio.ErrBufferFull {
			return nil, n, false, over, err
		}
	}
}
