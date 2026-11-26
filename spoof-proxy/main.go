// Command spoof-proxy is a local egress proxy that forwards Discord traffic over
// TLS connections whose ClientHello matches a real Chrome build.
//
// Discord fingerprints the TLS handshake, and Node's OpenSSL stack cannot
// reproduce Chrome's cipher and extension layout. This helper terminates the
// upstream TLS connection with bogdanfinn/tls-client (the same library discordo
// uses) and exposes it to the Node process as plain HTTP/1.1 on localhost.
//
// The two upstreams are handled differently because Chrome treats them
// differently:
//
//   - REST uses tls-client's fhttp client directly, so the request is a real
//     HTTP/2 request: Chrome's ALPN, SETTINGS and pseudo-header order, a shared
//     cookie jar for __dcfduid/__sdcfduid/__cfruid, and an explicit header order.
//   - Gateway keeps an HTTP/1.1 reverse proxy, because a WebSocket upgrade is
//     HTTP/1.1 by definition. tls-client's GetTLSDialer() always forces h1,
//     which is exactly right here.
//
// It is a generic egress proxy: it knows nothing about Discord beyond the two
// default targets, so no data-model boundary is introduced.
//
// The process prints one JSON line to stdout once both listeners are up:
//
//	{"rest":"http://127.0.0.1:PORT","gateway":"ws://127.0.0.1:PORT","profile":"Chrome 154"}
//
// Everything else goes to stderr.
package main

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/andybalholm/brotli"
	fhttp "github.com/bogdanfinn/fhttp"
	tls_client "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	"github.com/klauspost/compress/zstd"
)

// chromeAcceptEncoding is what Chrome 154 advertises. The proxy decompresses
// the response itself because Node's undici can decode gzip/deflate/br but not
// zstd, and advertising less than Chrome would be a fingerprint mismatch.
const chromeAcceptEncoding = "gzip, deflate, br, zstd"

type readyInfo struct {
	Rest    string `json:"rest"`
	Gateway string `json:"gateway"`
	Profile string `json:"profile"`
}

// restHeaderOrder is the order Chrome uses for a same-origin fetch from the
// Discord web app. Headers absent from the list keep their relative
// lexicographic order after the listed ones (fhttp's sorter does that), so this
// only needs to cover the headers Discord actually receives.
var restHeaderOrder = []string{
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
	"authorization",
	"origin",
	"user-agent",
	"content-type",
	"accept",
	"x-super-properties",
	"x-discord-locale",
	"x-discord-timezone",
	"x-debug-options",
	"sec-fetch-site",
	"sec-fetch-mode",
	"sec-fetch-dest",
	"referer",
	"accept-encoding",
	"accept-language",
	"priority",
	"cookie",
}

// wsHeaderOrder is the order Chrome uses for a WebSocket handshake. fhttp's
// HTTP/1.1 writer honours it via HeaderOrderKey (stdlib net/http always sorts
// alphabetically). Host and User-Agent are written first by the transport
// itself, as they are in Chrome.
var wsHeaderOrder = []string{
	"host",
	"connection",
	"pragma",
	"cache-control",
	"user-agent",
	"upgrade",
	"origin",
	"sec-fetch-mode",
	"sec-websocket-version",
	"accept-encoding",
	"accept-language",
	"sec-websocket-key",
	"sec-websocket-extensions",
}

// Hop-by-hop headers must not be forwarded by a proxy (RFC 7230 §6.1).
var hopByHop = map[string]bool{
	"Connection":          true,
	"Keep-Alive":          true,
	"Proxy-Authenticate":  true,
	"Proxy-Authorization": true,
	"Te":                  true,
	"Trailer":             true,
	"Transfer-Encoding":   true,
	"Upgrade":             true,
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("spoof-proxy: ")

	var (
		restAddr  = flag.String("rest-addr", "127.0.0.1:0", "listen address for the REST proxy")
		gwAddr    = flag.String("gateway-addr", "127.0.0.1:0", "listen address for the Gateway proxy")
		restURL   = flag.String("rest-target", "https://discord.com", "upstream for REST traffic")
		gwURL     = flag.String("gateway-target", "wss://gateway.discord.gg", "upstream for Gateway traffic")
		profName  = flag.String("profile", "Chrome_154", "TLS client profile name")
		userAgent = flag.String("user-agent", "", "User-Agent to send on the Gateway handshake")
		lang      = flag.String("accept-language", "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7", "Accept-Language for the Gateway handshake")
		origin    = flag.String("origin", "https://discord.com", "Origin for the Gateway handshake")
		verbose   = flag.Bool("debug", false, "log proxied requests and upstream errors")
	)
	flag.Parse()

	profile, err := lookupProfile(*profName)
	if err != nil {
		log.Fatal(err)
	}

	restTarget, err := parseTarget(*restURL)
	if err != nil {
		log.Fatalf("rest target: %v", err)
	}
	gwTarget, err := parseTarget(*gwURL)
	if err != nil {
		log.Fatalf("gateway target: %v", err)
	}

	dialer := net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	transportOptions := &tls_client.TransportOptions{
		// The proxy forwards the caller's Accept-Encoding verbatim and returns
		// the still-compressed body, so Node decompresses exactly as it would
		// for a direct fetch. Letting fhttp add its own header would duplicate
		// it (it looks up the lowercase key while Go canonicalises it).
		DisableCompression: true,
		ReadIdleTimeout:    30 * time.Second,
		PingTimeout:        15 * time.Second,
		IdleConnTimeout:    durationPtr(90 * time.Second),
	}

	// A zero client timeout keeps long-lived connections alive; per-request
	// deadlines come from the caller (Node aborts REST calls after 20s).
	restClient, err := tls_client.NewHttpClient(
		tls_client.NewNoopLogger(),
		tls_client.WithClientProfile(profile),
		tls_client.WithRandomTLSExtensionOrder(),
		tls_client.WithTimeoutSeconds(0),
		tls_client.WithCookieJar(tls_client.NewCookieJar()),
		tls_client.WithDialer(dialer),
		tls_client.WithTransportOptions(transportOptions),
	)
	if err != nil {
		log.Fatalf("create REST tls client: %v", err)
	}

	// The Gateway is a WebSocket: HTTP/1.1 by definition. GetTLSDialer() forces
	// h1 for the same Chrome ClientHello the REST client uses.
	gwClient, err := tls_client.NewHttpClient(
		tls_client.NewNoopLogger(),
		tls_client.WithClientProfile(profile),
		tls_client.WithRandomTLSExtensionOrder(),
		tls_client.WithForceHttp1(),
		tls_client.WithTimeoutSeconds(0),
		tls_client.WithDialer(dialer),
	)
	if err != nil {
		log.Fatalf("create gateway tls client: %v", err)
	}

	restHandler := newRestHandler(restTarget, restClient, *verbose)
	gwHandler := newGatewayHandler(gwTarget, gwClient.GetTLSDialer(), gatewayHeaders{
		userAgent:      *userAgent,
		acceptLanguage: *lang,
		origin:         *origin,
	}, *verbose)

	restLn, err := net.Listen("tcp", *restAddr)
	if err != nil {
		log.Fatalf("listen %s: %v", *restAddr, err)
	}
	gwLn, err := net.Listen("tcp", *gwAddr)
	if err != nil {
		_ = restLn.Close()
		log.Fatalf("listen %s: %v", *gwAddr, err)
	}

	restSrv := &http.Server{Handler: restHandler, ReadHeaderTimeout: 20 * time.Second}
	gwSrv := &http.Server{Handler: gwHandler, ReadHeaderTimeout: 20 * time.Second}

	// Suspend/resume leaves the pooled REST connections looking alive while
	// their peer is gone. Go's idle timers use the monotonic clock, which does
	// not advance during suspend, so evict them explicitly on a wall-clock jump.
	go watchClockJumps(restClient, gwClient)

	hello := profile.GetClientHelloId()
	info := readyInfo{
		Rest:    "http://" + restLn.Addr().String(),
		Gateway: "ws://" + gwLn.Addr().String(),
		Profile: hello.Client + " " + hello.Version,
	}
	if err := json.NewEncoder(os.Stdout).Encode(info); err != nil {
		log.Fatalf("write ready line: %v", err)
	}
	_ = os.Stdout.Sync()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if err := restSrv.Serve(restLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("rest server: %v", err)
		}
	}()
	go func() {
		defer wg.Done()
		if err := gwSrv.Serve(gwLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("gateway server: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig

	// WebSocket connections are hijacked, so Shutdown cannot wait for them;
	// the deadline keeps exit prompt.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = restSrv.Shutdown(ctx)
	_ = gwSrv.Shutdown(ctx)
	restClient.CloseIdleConnections()
	gwClient.CloseIdleConnections()
	wg.Wait()
}

// newRestHandler forwards REST requests through tls-client's fhttp client, so
// the upstream leg is a genuine HTTP/2 request with Chrome's ALPN, SETTINGS,
// pseudo-header order and cookie jar.
func newRestHandler(target *url.URL, client tls_client.HttpClient, verbose bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			log.Printf("read %s %s body: %v", r.Method, r.URL.Path, err)
			http.Error(w, "read body", http.StatusBadRequest)
			return
		}

		outURL := *target
		outURL.Path = singleJoiningSlash(target.Path, r.URL.Path)
		outURL.RawQuery = r.URL.RawQuery

		outReq, err := fhttp.NewRequestWithContext(
			r.Context(), r.Method, outURL.String(), bytes.NewReader(body),
		)
		if err != nil {
			log.Printf("build %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, "build request", http.StatusBadGateway)
			return
		}

		copyHeaders(http.Header(outReq.Header), r.Header)
		// fhttp honours this magic header for the h2 header block. Its values
		// must be lowercase; tls-client lowercases them again defensively.
		outReq.Header[fhttp.HeaderOrderKey] = restHeaderOrder
		// Advertise exactly what Chrome does; the response is decoded below.
		outReq.Header.Set("Accept-Encoding", chromeAcceptEncoding)

		if verbose {
			log.Printf("%s %s%s", r.Method, outURL.Host, outURL.RequestURI())
		}

		resp, err := client.Do(outReq)
		if err != nil {
			log.Printf("upstream %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		decoded, err := readResponseBody(resp)
		if err != nil {
			log.Printf("decode %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, "upstream decode error", http.StatusBadGateway)
			return
		}

		copyHeaders(w.Header(), http.Header(resp.Header))
		w.Header().Set("Content-Length", strconv.Itoa(len(decoded)))
		w.WriteHeader(resp.StatusCode)
		if _, err := w.Write(decoded); err != nil && verbose {
			log.Printf("copy %s %s: %v", r.Method, r.URL.Path, err)
		}
	})
}

// readResponseBody returns the fully decoded response body. The upstream
// Content-Encoding/Content-Length headers are removed when the body was
// decompressed, so the caller can write plain bytes with a fresh length.
func readResponseBody(resp *fhttp.Response) ([]byte, error) {
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	encoding := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding")))
	if encoding == "" || encoding == "identity" {
		return raw, nil
	}

	decoded, err := decompress(encoding, raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", encoding, err)
	}
	resp.Header.Del("Content-Encoding")
	resp.Header.Del("Content-Length")
	return decoded, nil
}

func decompress(encoding string, raw []byte) ([]byte, error) {
	switch encoding {
	case "gzip":
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		return io.ReadAll(zr)
	case "deflate":
		// HTTP "deflate" is zlib-wrapped, but some servers send raw deflate.
		zr, err := zlib.NewReader(bytes.NewReader(raw))
		if err != nil {
			fr := flate.NewReader(bytes.NewReader(raw))
			defer fr.Close()
			return io.ReadAll(fr)
		}
		defer zr.Close()
		return io.ReadAll(zr)
	case "br":
		return io.ReadAll(brotli.NewReader(bytes.NewReader(raw)))
	case "zstd":
		zr, err := zstd.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		return io.ReadAll(zr)
	default:
		return nil, errors.New("unsupported content-encoding")
	}
}

type gatewayHeaders struct {
	userAgent      string
	acceptLanguage string
	origin         string
}

// newGatewayHandler builds an HTTP/1.1 reverse proxy to target whose upstream
// connection is made through dial. WebSocket upgrades pass through because
// httputil.ReverseProxy preserves Connection/Upgrade and hijacks both sides on
// a 101 response.
// allowedGatewayHost limits X-Spoof-Host to Discord's own gateway hosts so the
// helper can never be turned into a general-purpose proxy.
func allowedGatewayHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "discord.com" || host == "discord.gg" {
		return true
	}
	return strings.HasSuffix(host, ".discord.com") || strings.HasSuffix(host, ".discord.gg")
}

const wakeClockJumpSeconds = 10

type idleConnectionCloser interface {
	CloseIdleConnections()
}

// wakeClockJump reports whether the wall clock advanced far more than the
// monotonic ticker, which is what a suspend/resume looks like from here.
func wakeClockJump(previous, current int64) bool {
	return current-previous > wakeClockJumpSeconds
}

func watchClockJumps(rest, gateway idleConnectionCloser) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	last := time.Now().Unix()
	for range ticker.C {
		now := time.Now().Unix()
		if wakeClockJump(last, now) {
			log.Printf("clock jumped %ds; dropping idle upstream connections", now-last)
			rest.CloseIdleConnections()
			gateway.CloseIdleConnections()
		}
		last = now
	}
}

func newGatewayHandler(target *url.URL, dial tls_client.TLSDialerFunc, hdr gatewayHeaders, verbose bool) *httputil.ReverseProxy {
	transport := &fhttp.Transport{
		Proxy:                 nil, // never inherit an ambient proxy
		DialTLSContext:        dial,
		ForceAttemptHTTP2:     false,
		DisableCompression:    true,
		MaxIdleConns:          8,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
	}

	return &httputil.ReverseProxy{
		Transport: &fhttpTransport{transport: transport},
		// -1 flushes every write, which the Gateway needs.
		FlushInterval: -1,
		Director: func(req *http.Request) {
			// READY advertises a resume URL on a shard-specific host
			// (`gateway-us-east1-b.discord.gg`). Node tells us that host here
			// so the resume can still go through this proxy. The header never
			// reaches Discord and the value is restricted to Discord's own
			// domains, so this cannot be used as an open proxy.
			host := target.Host
			if hint := req.Header.Get("X-Spoof-Host"); hint != "" {
				// The configured target is always allowed, which also keeps
				// local test targets usable.
				if hint == target.Host || allowedGatewayHost(hint) {
					host = hint
				}
				req.Header.Del("X-Spoof-Host")
			}
			req.URL.Scheme = "https"
			req.URL.Host = host
			req.Host = host
			// Stay faithful to a browser: no proxy-injected headers. A nil value
			// tells ReverseProxy to omit X-Forwarded-For entirely.
			req.Header["X-Forwarded-For"] = nil
			req.Header.Del("Forwarded")
			req.Header.Del("Via")

			// Node's WebSocket identifies itself as `node` and sends
			// `Accept-Language: *`. Replace those with what Chrome sends on a
			// WebSocket handshake so the upgrade is not trivially distinguishable.
			if hdr.userAgent != "" {
				req.Header.Set("User-Agent", hdr.userAgent)
			}
			if hdr.acceptLanguage != "" {
				req.Header.Set("Accept-Language", hdr.acceptLanguage)
			}
			if hdr.origin != "" {
				req.Header.Set("Origin", hdr.origin)
			}
			req.Header.Set("Accept-Encoding", "gzip, deflate, br, zstd")
			// Chrome does not send Accept on a WebSocket handshake; Node's
			// undici client does.
			req.Header.Del("Accept")

			if verbose {
				log.Printf("%s %s%s", req.Method, host, req.URL.RequestURI())
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("upstream %s %s: %v", r.Method, r.URL.Path, err)
			w.WriteHeader(http.StatusBadGateway)
		},
	}
}

// fhttpTransport adapts fhttp's HTTP/1.1 transport to the stdlib RoundTripper
// interface that httputil.ReverseProxy expects. It exists only to control the
// header order: stdlib net/http always writes headers alphabetically, while
// fhttp honours HeaderOrderKey. The response body is passed through untouched
// so a 101 upgrade still implements io.ReadWriteCloser and ReverseProxy can
// hijack both sides.
type fhttpTransport struct {
	transport *fhttp.Transport
}

func (t *fhttpTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	out, err := fhttp.NewRequestWithContext(req.Context(), req.Method, req.URL.String(), req.Body)
	if err != nil {
		return nil, err
	}
	out.Header = fhttp.Header(req.Header.Clone())
	out.Host = req.Host
	out.ContentLength = req.ContentLength
	out.Header[fhttp.HeaderOrderKey] = wsHeaderOrder

	res, err := t.transport.RoundTrip(out)
	if err != nil {
		return nil, err
	}

	return &http.Response{
		Status:           res.Status,
		StatusCode:       res.StatusCode,
		Proto:            res.Proto,
		ProtoMajor:       res.ProtoMajor,
		ProtoMinor:       res.ProtoMinor,
		Header:           http.Header(res.Header),
		Body:             res.Body,
		ContentLength:    res.ContentLength,
		TransferEncoding: res.TransferEncoding,
		Close:            res.Close,
		Uncompressed:     res.Uncompressed,
		Request:          req,
	}, nil
}

func copyHeaders(dst, src http.Header) {
	for key, values := range src {
		if hopByHop[http.CanonicalHeaderKey(key)] {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func parseTarget(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse target %q: %w", raw, err)
	}
	if u.Host == "" {
		return nil, fmt.Errorf("target %q has no host", raw)
	}
	return u, nil
}

func singleJoiningSlash(a, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash:
		return a + "/" + b
	}
	return a + b
}

func durationPtr(d time.Duration) *time.Duration { return &d }

func lookupProfile(name string) (profiles.ClientProfile, error) {
	if p, ok := profiles.MappedTLSClients[strings.ToLower(name)]; ok {
		return p, nil
	}
	return profiles.ClientProfile{}, fmt.Errorf(
		"unknown TLS profile %q (try Chrome_154)", name,
	)
}
