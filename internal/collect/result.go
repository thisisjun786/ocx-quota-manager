package collect

// ValidResult is the request-result vocabulary shared by storage and HTTP filters.
func ValidResult(result string) bool {
	switch result {
	case "ok", "network", "timeout", "redirect", "oversized", "credential_echoed", "rate_limited", "unauthorized", "access_denied", "server_error", "unexpected_status", "base_url_mismatch", "invalid_json", "observation_unavailable":
		return true
	}
	return false
}
