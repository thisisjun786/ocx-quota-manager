package nativeusage

import (
	"os"
	"strconv"
	"syscall"
)

// Match the store's Linux inode check, with device identity for moved mounts.
func fileID(info os.FileInfo) string {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return strconv.FormatUint(uint64(st.Dev), 10) + ":" + strconv.FormatUint(st.Ino, 10)
	}
	return ""
}
