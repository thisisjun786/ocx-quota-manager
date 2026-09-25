//go:build !linux

package main

// Unsupported outside Linux. Both report -1, which the integration harness
// treats as an unmeasured metric and fails closed, never as a passing zero.
func rusageUsec() int64 { return -1 }

func ioWriteBytes() int64 { return -1 }
