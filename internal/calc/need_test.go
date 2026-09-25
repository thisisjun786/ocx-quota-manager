package calc

import "testing"

func TestNeededAccountsCorpus(t *testing.T) {
	if got := NeededAccounts(100, 168, 24); got != 7 {
		t.Fatalf("weekly 24h 100pp: %d", got)
	}
	if got := NeededAccounts(100, 720, 24); got != 30 {
		t.Fatalf("monthly 24h 100pp: %d", got)
	}
	if got := NeededAccounts(100, 168, 0); got != 0 {
		t.Fatalf("zero period: %d", got)
	}
}
