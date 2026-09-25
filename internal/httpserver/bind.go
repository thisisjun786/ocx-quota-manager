package httpserver

import (
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

func AllowedBind(host string, port int) error {
	if port < 1024 || port > 65535 {
		return fmt.Errorf("unprivileged port required")
	}
	if host == "127.0.0.1" {
		return nil
	}
	if tailnetIPv4(host) {
		return nil
	}
	return fmt.Errorf("use loopback or a Tailscale IPv4")
}

func tailnetIPv4(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil || ip.To4() == nil {
		return false
	}
	parts := strings.Split(host, ".")
	if len(parts) != 4 {
		return false
	}
	a, _ := strconv.Atoi(parts[0])
	b, _ := strconv.Atoi(parts[1])
	return a == 100 && b >= 64 && b <= 127
}

func CheckPublicOrigin(host, publicOrigin string) (*url.URL, error) {
	if publicOrigin == "" {
		return nil, nil
	}
	if host != "127.0.0.1" {
		return nil, fmt.Errorf("Use a Tailscale HTTPS origin with a loopback backend")
	}
	u, err := url.Parse(publicOrigin)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" || !strings.HasSuffix(u.Hostname(), ".ts.net") ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return nil, fmt.Errorf("Use a Tailscale HTTPS origin with a loopback backend")
	}
	return u, nil
}

func LocalProxy(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	switch host {
	case "127.0.0.1", "::1", "::ffff:127.0.0.1":
		return true
	default:
		return false
	}
}
