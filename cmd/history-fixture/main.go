package main

import (
	"fmt"
	"os"

	"github.com/thisisjun786/ocx-quota-manager/internal/store"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: history-fixture DIR")
		os.Exit(2)
	}
	h, err := store.Open(os.Args[1], store.OpenOptions{})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer h.Close()
	acc := "a1"
	usd := 2.5
	if err := h.InsertUsage(store.Usage{ID: "n1", At: 1800000000000, Provider: "openai", Account: &acc, USD: &usd}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := h.SetMeta("usageCursor", map[string]any{"ino": "1", "offset": 10}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
