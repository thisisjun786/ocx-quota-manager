package store

import (
	"os"
	"strconv"
	"syscall"
)

func statIno(info os.FileInfo) string {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return strconv.FormatUint(st.Ino, 10)
	}
	return info.Name()
}
