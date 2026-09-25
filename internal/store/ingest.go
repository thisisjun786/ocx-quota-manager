package store

import (
	"bufio"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

type UsageCursor struct {
	Ino         string `json:"ino"`
	Offset      int64  `json:"offset"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

type LogEntry struct {
	Timestamp int64            `json:"timestamp"`
	RequestID string           `json:"requestId"`
	Attempts  []map[string]any `json:"attempts"`
	Provider  string           `json:"provider"`
	Model     string           `json:"model"`
	Usage     map[string]any   `json:"usage"`
}

// IngestJSONL appends complete lines and advances the cursor in the same
// transaction. A truncated last line is left unread. Parent rows with attempts
// are not double-counted: only attempts are stored.
func (h *History) IngestJSONL(path string, now int64) (int, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	fingerprint := fileFingerprint(f, info.Size())
	ino := statIno(info)
	prev, _ := h.Meta("usageCursor")
	cursor := UsageCursor{Ino: ino, Fingerprint: fingerprint}
	if m, ok := prev.(map[string]any); ok {
		if sameFile(m, ino, fingerprint) {
			if off, ok := m["offset"].(float64); ok && int64(off) <= info.Size() {
				cursor.Offset = int64(off)
			}
		}
	}
	if cursor.Offset > 0 {
		if _, err := f.Seek(cursor.Offset, io.SeekStart); err != nil {
			return 0, err
		}
	}
	// One bounded replay repairs unpriced rows written by the conditional-tariff
	// regression. Settled amounts remain protected by settleIngest.
	replay, _ := h.Meta("conditionalPriceReplay")
	// tariffRevision names the source-owned tariff generation. A new generation
	// replays the log once and may replace an amount only when the tariff for
	// that row changed (repriceRow). Earlier settled amounts stay otherwise.
	tariff, _ := h.Meta("tariffRevision")
	repricing := tariff != TariffRevision
	if repricing {
		replay = nil
	}
	catalog, catalogRevision := h.catalogForIngest()
	if prior, _ := h.Meta("catalogPriceRevision"); catalog != nil && prior != catalogRevision {
		// A catalog that now prices a model we hold unpriced rows for: read the log
		// again once. settleIngest only fills amounts that are still unknown.
		replay = nil
	}
	if replay != "v1" {
		cursor.Offset = 0
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return 0, err
		}
	}
	cutoff := now - int64(h.retentionDays)*86400000
	for _, key := range []string{"historyResetAt", "usageExcludedBefore"} {
		if v, ok := h.Meta(key); ok {
			if n, ok := v.(float64); ok && int64(n) > cutoff {
				cutoff = int64(n)
			}
		}
	}
	identities := usageIdentities(filepath.Dir(path))
	reader := bufio.NewReader(f)
	var inserted int
	var touched []string
	err = h.transact(func(tx *sql.Tx) error {
		evidence, err := listEvidence(tx)
		if err != nil {
			return err
		}
		offset := cursor.Offset
		completeTail := false
		for {
			line, err := reader.ReadBytes('\n')
			if err == io.EOF {
				// Keep a partial last line unconsumed.
				completeTail = len(line) == 0
				break
			}
			if err != nil {
				return err
			}
			next := offset + int64(len(line))
			trimmed := trimNL(line)
			if len(trimmed) == 0 {
				offset = next
				continue
			}
			var entry LogEntry
			if json.Unmarshal(trimmed, &entry) != nil || entry.RequestID == "" || entry.Timestamp <= 0 || entry.Timestamp > now+60000 || entry.Timestamp < cutoff {
				offset = next
				continue
			}
			attempts := entry.Attempts
			if len(attempts) == 0 {
				var parent map[string]any
				if err := json.Unmarshal(trimmed, &parent); err != nil {
					return err
				}
				attempts = []map[string]any{parent}
			}
			for i, row := range attempts {
				if locallyAnswered(row) {
					continue
				}
				id := attemptID(entry.RequestID, i)
				provider, _ := row["provider"].(string)
				if provider == "" {
					provider = entry.Provider
				}
				if provider == "" {
					provider = "unknown"
				}
				account := attributedAccount(provider, row, identities)
				provider = usageProvider(provider)
				model, _ := row["model"].(string)
				usage, _ := row["usage"].(map[string]any)
				input := numPtr(usage, "inputTokens")
				output := numPtr(usage, "outputTokens")
				cached := firstNum(usage, "cacheReadInputTokens", "cachedInputTokens")
				tokens := firstNum(usage, "totalTokens")
				if tokens == nil && input != nil && output != nil {
					sum := *input + *output
					tokens = &sum
				}
				quote := quoteIngest(provider, model, entry.Timestamp, row, evidence, catalog)
				result, err := tx.Exec(`INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?)
					ON CONFLICT(id) DO NOTHING`,
					id, entry.Timestamp, provider, account, nilIfEmpty(model), input, output, cached, tokens, quote.usd, quote.basis)
				if err != nil {
					return err
				}
				created, err := result.RowsAffected()
				if err != nil {
					return err
				}
				if created == 0 {
					touched = append(touched, id)
				}
				if err := settleIngest(tx, created > 0, id, entry.Timestamp, provider, model, input, output, cached, tokens, quote, now, repricing && repriceRow(provider, model, row)); err != nil {
					return err
				}
				// A replay may restore a proven log label on an otherwise identical row.
				// It never changes a prior account association or a settled dollar amount.
				if account != nil {
					if _, err := tx.Exec(`UPDATE usage SET account=? WHERE id=? AND account IS NULL AND provider=? AND model IS ? AND at=? AND input IS ? AND output IS ? AND cached IS ? AND tokens IS ?`, account, id, provider, nilIfEmpty(model), entry.Timestamp, input, output, cached, tokens); err != nil {
						return err
					}
				}
				inserted++
			}
			offset = next
		}
		cursor.Offset = offset
		cursor.Ino = ino
		cursor.Fingerprint = fingerprint
		raw, err := json.Marshal(cursor)
		if err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT OR REPLACE INTO meta VALUES (?,?)", "usageCursor", string(raw)); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT OR REPLACE INTO meta VALUES (?,?)", "conditionalPriceReplay", `"v1"`); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT OR REPLACE INTO meta VALUES (?,?)", "tariffRevision", `"`+TariffRevision+`"`); err != nil {
			return err
		}
		if catalog != nil {
			encoded, _ := json.Marshal(catalogRevision)
			if _, err := tx.Exec("INSERT OR REPLACE INTO meta VALUES (?,?)", "catalogPriceRevision", string(encoded)); err != nil {
				return err
			}
		}
		if completeTail {
			if _, err := tx.Exec("INSERT OR REPLACE INTO meta VALUES (?,?)", "usageObservedThrough", now); err != nil {
				return err
			}
		}
		if _, err := tx.Exec("INSERT OR IGNORE INTO meta VALUES (?,?)", "usageObservedSince", now); err != nil {
			return err
		}
		return h.bumpUsageRevision(tx)
	})
	h.markUsageDirty(touched)
	return inserted, err
}

func trimNL(line []byte) []byte {
	for len(line) > 0 && (line[len(line)-1] == '\n' || line[len(line)-1] == '\r') {
		line = line[:len(line)-1]
	}
	return line
}

func locallyAnswered(row map[string]any) bool {
	v, ok := row["locallyAnswered"]
	return ok && v == true
}

func attemptID(requestID string, index int) string {
	sum := sha256.Sum256([]byte(requestID + "\x00" + itoa(index)))
	return hex.EncodeToString(sum[:])
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func numPtr(m map[string]any, key string) *float64 {
	if m == nil {
		return nil
	}
	v, ok := m[key]
	if !ok {
		return nil
	}
	f, ok := v.(float64)
	if !ok {
		return nil
	}
	return &f
}

func firstNum(m map[string]any, keys ...string) *float64 {
	for _, k := range keys {
		if p := numPtr(m, k); p != nil {
			return p
		}
	}
	return nil
}

func sameFile(m map[string]any, ino, fingerprint string) bool {
	got, _ := m["ino"].(string)
	if got != ino {
		return false
	}
	fp, _ := m["fingerprint"].(string)
	return fp == "" || fp == fingerprint
}

func fileFingerprint(f *os.File, size int64) string {
	n := size
	if n > 64 {
		n = 64
	}
	buf := make([]byte, n)
	_, _ = f.ReadAt(buf, 0)
	if len(buf) < 64 {
		return ""
	}
	sum := sha256.Sum256(buf)
	return hex.EncodeToString(sum[:])
}

// The suffix is a log routing label, not a separate provider. Attribution is
// kept unknown without an independently established account identity.
var usageProviderSuffix = regexp.MustCompile(`-(?:main|[pko][a-f0-9]{6})$`)

func usageProvider(raw string) string {
	provider := usageProviderSuffix.ReplaceAllString(raw, "")
	if provider == "chatgpt" || provider == "openai-multi" {
		return "openai"
	}
	return provider
}
