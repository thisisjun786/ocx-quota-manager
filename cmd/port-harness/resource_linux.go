//go:build linux

package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// rusageUsec is user+system CPU in microseconds for a delta window, the same
// unit process.cpuUsage reports on the Node side. Call it before and after
// the measured collect and subtract.
func rusageUsec() int64 {
	var r syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &r); err != nil {
		return -1
	}
	return (r.Utime.Sec+r.Stime.Sec)*1_000_000 + int64(r.Utime.Usec) + int64(r.Stime.Usec)
}

// ioWriteBytes reads the wchar field of /proc/self/io: the bytes this process
// has passed to write() syscalls. Delta windows attribute them to one collect.
// This is write volume, not file-size footprint.
func ioWriteBytes() int64 {
	raw, err := os.ReadFile("/proc/self/io")
	if err != nil {
		return -1
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "wchar:") {
			n, _ := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "wchar:")), 10, 64)
			return n
		}
	}
	return -1
}
