package main

import (
	"net/http"
	"net/url"
	"testing"
)

func TestAllowedGatewayHost(t *testing.T) {
	allowed := []string{
		"discord.gg",
		"gateway.discord.gg",
		"gateway-us-east1-b.discord.gg",
		"discord.com",
		"gateway.discord.gg.",
	}
	for _, host := range allowed {
		if !allowedGatewayHost(host) {
			t.Errorf("allowedGatewayHost(%q) = false, want true", host)
		}
	}

	rejected := []string{
		"",
		"evil.example.com",
		"discord.gg.evil.example.com",
		"notdiscord.gg",
		"127.0.0.1:8080",
		"localhost",
	}
	for _, host := range rejected {
		if allowedGatewayHost(host) {
			t.Errorf("allowedGatewayHost(%q) = true, want false", host)
		}
	}
}

// TestGatewayDirectorFollowsResumeHost covers the RESUME path: READY advertises
// a shard host, Node rewrites the URL onto the local proxy and passes the real
// host in X-Spoof-Host. The Director must dial that host and must not forward
// the hint upstream.
func TestGatewayDirectorFollowsResumeHost(t *testing.T) {
	target, err := url.Parse("wss://gateway.discord.gg")
	if err != nil {
		t.Fatal(err)
	}
	proxy := newGatewayHandler(target, nil, gatewayHeaders{}, false)

	req := &http.Request{
		Method: http.MethodGet,
		URL:    &url.URL{Scheme: "http", Host: "127.0.0.1:1234", Path: "/", RawQuery: "v=9&encoding=json"},
		Header: http.Header{
			"X-Spoof-Host": {"gateway-us-east1-b.discord.gg"},
		},
		Host: "127.0.0.1:1234",
	}
	proxy.Director(req)

	if req.URL.Host != "gateway-us-east1-b.discord.gg" {
		t.Errorf("URL.Host = %q, want the resume host", req.URL.Host)
	}
	if req.Host != "gateway-us-east1-b.discord.gg" {
		t.Errorf("Host = %q, want the resume host", req.Host)
	}
	if req.URL.Scheme != "https" {
		t.Errorf("URL.Scheme = %q, want https", req.URL.Scheme)
	}
	if got := req.Header.Get("X-Spoof-Host"); got != "" {
		t.Errorf("X-Spoof-Host leaked upstream: %q", got)
	}
}

// TestGatewayDirectorRejectsForeignHost keeps the helper from being usable as
// an open proxy.
func TestGatewayDirectorRejectsForeignHost(t *testing.T) {
	target, err := url.Parse("wss://gateway.discord.gg")
	if err != nil {
		t.Fatal(err)
	}
	proxy := newGatewayHandler(target, nil, gatewayHeaders{}, false)

	req := &http.Request{
		Method: http.MethodGet,
		URL:    &url.URL{Scheme: "http", Host: "127.0.0.1:1234", Path: "/"},
		Header: http.Header{"X-Spoof-Host": {"evil.example.com"}},
		Host:   "127.0.0.1:1234",
	}
	proxy.Director(req)

	if req.URL.Host != "gateway.discord.gg" {
		t.Errorf("URL.Host = %q, want the configured target", req.URL.Host)
	}
	if got := req.Header.Get("X-Spoof-Host"); got != "" {
		t.Errorf("X-Spoof-Host leaked upstream: %q", got)
	}
}

func TestWakeClockJump(t *testing.T) {
	if wakeClockJump(100, 105) {
		t.Error("a normal five-second gap is not a resume")
	}
	if !wakeClockJump(100, 111) {
		t.Error("a gap longer than ten seconds is treated as a resume")
	}
	if wakeClockJump(100, 90) {
		t.Error("a backwards clock adjustment is not a resume")
	}
}
