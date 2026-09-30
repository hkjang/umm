// Package mail sends event notifications through the company SMTP relay.
//
// The relay in most installations is the plain one: port 25, no credentials,
// no TLS unless it offers STARTTLS. So the transport takes what the server
// advertises and asks for nothing more — encryption and authentication happen
// when they are configured or offered, and a relay that has neither works with
// the same settings row.
//
// Nothing here is allowed to slow a request down. A notification is handed to
// the Service, which records it and sends it from a goroutine; the comment or
// the approval that caused it has long been answered by the time the relay
// says anything. Every attempt is recorded — sent or failed, with the reason —
// so an administrator can answer "it never arrived" without guessing.
package mail

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

var (
	ErrDisabled = errors.New("mail is off")
	ErrInvalid  = errors.New("mail configuration is incomplete")
)

// Message is one mail as it goes to the relay.
type Message struct {
	To      string
	Subject string
	Body    string
}

// Deliver opens one connection to the relay and sends one message. Exported so
// the administrator's test button and the background service share the exact
// same path: what the test proves is what the notifications will use.
func Deliver(ctx context.Context, config Config, message Message) error {
	if err := config.validate(); err != nil {
		return err
	}
	if !looksLikeAddress(strings.TrimSpace(message.To)) {
		return fmt.Errorf("%w: 받는 사람 주소가 메일 주소가 아닙니다", ErrInvalid)
	}
	client, err := dial(ctx, config)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()
	if err := session(client, config); err != nil {
		return err
	}
	if err := client.Mail(config.FromAddress); err != nil {
		return fmt.Errorf("MAIL FROM 거절: %w", err)
	}
	if err := client.Rcpt(strings.TrimSpace(message.To)); err != nil {
		return fmt.Errorf("RCPT TO 거절: %w", err)
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("DATA 거절: %w", err)
	}
	if _, err := writer.Write([]byte(compose(config, message, time.Now()))); err != nil {
		return fmt.Errorf("본문 전송 실패: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("본문이 받아들여지지 않음: %w", err)
	}
	return client.Quit()
}

// dial connects within the configured timeout and puts the same deadline on
// the whole conversation, so a relay that accepts the connection and then
// goes quiet cannot keep a goroutine for ever.
func dial(ctx context.Context, config Config) (*smtp.Client, error) {
	dialer := &net.Dialer{Timeout: config.Timeout}
	var connection net.Conn
	var err error
	if config.Security == "tls" {
		connection, err = tls.DialWithDialer(dialer, "tcp", config.endpoint(), config.tlsConfig())
	} else {
		connection, err = dialer.DialContext(ctx, "tcp", config.endpoint())
	}
	if err != nil {
		return nil, fmt.Errorf("SMTP 릴레이 %s 에 연결하지 못함: %w", config.endpoint(), err)
	}
	_ = connection.SetDeadline(time.Now().Add(config.Timeout))
	client, err := smtp.NewClient(connection, config.Host)
	if err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("SMTP 인사(220)를 받지 못함: %w", err)
	}
	return client, nil
}

// session goes as far as the relay allows: STARTTLS when it is offered (or
// required), credentials only when a username is configured. An internal
// relay that offers neither is not an error.
func session(client *smtp.Client, config Config) error {
	if err := client.Hello(helloName(config)); err != nil {
		return fmt.Errorf("EHLO 거절: %w", err)
	}
	if config.Security == "starttls" || config.Security == "auto" {
		if offered, _ := client.Extension("STARTTLS"); offered {
			if err := client.StartTLS(config.tlsConfig()); err != nil {
				return fmt.Errorf("STARTTLS 실패: %w", err)
			}
		} else if config.Security == "starttls" {
			return fmt.Errorf("%w: 릴레이가 STARTTLS 를 제공하지 않습니다 (보안 방식을 auto 나 none 으로)", ErrInvalid)
		}
	}
	if config.Username == "" {
		return nil
	}
	offered, mechanisms := client.Extension("AUTH")
	if !offered {
		return fmt.Errorf("%w: 릴레이가 인증을 받지 않습니다 (사용자 이름을 비우면 인증 없이 보냅니다)", ErrInvalid)
	}
	upper := strings.ToUpper(mechanisms)
	var auth smtp.Auth
	switch {
	case strings.Contains(upper, "PLAIN"):
		auth = smtp.PlainAuth("", config.Username, config.Password, config.Host)
	case strings.Contains(upper, "LOGIN"):
		auth = loginAuth{username: config.Username, password: config.Password, host: config.Host}
	default:
		auth = smtp.CRAMMD5Auth(config.Username, config.Password)
	}
	if err := client.Auth(auth); err != nil {
		// The library's own message never carries the credential; ours must not
		// either, so the wrapping names the step and nothing else.
		return fmt.Errorf("SMTP 인증 실패: %w", err)
	}
	return nil
}

func (c Config) tlsConfig() *tls.Config {
	return &tls.Config{ServerName: c.Host, MinVersion: tls.VersionTLS12, InsecureSkipVerify: c.SkipVerify} //nolint:gosec // an explicit, off-by-default choice for relays with a private certificate
}

// helloName is the sender's domain. Relays that check the greeting prefer it
// to a container hostname.
func helloName(config Config) string {
	if at := strings.LastIndex(config.FromAddress, "@"); at >= 0 && at+1 < len(config.FromAddress) {
		return config.FromAddress[at+1:]
	}
	return "localhost"
}

// loginAuth is the LOGIN mechanism, which some corporate relays offer instead
// of PLAIN. The standard library ships PLAIN and CRAM-MD5 only. Like PLAIN it
// refuses to hand the password over a connection that is neither encrypted
// nor to the host it was configured for.
type loginAuth struct{ username, password, host string }

func (a loginAuth) Start(server *smtp.ServerInfo) (string, []byte, error) {
	if !server.TLS && server.Name != a.host {
		return "", nil, errors.New("LOGIN 인증은 암호화된 연결이나 설정한 호스트에만 보냅니다")
	}
	return "LOGIN", nil, nil
}

func (a loginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	switch strings.ToLower(strings.TrimRight(strings.TrimSpace(string(fromServer)), ":")) {
	case "username":
		return []byte(a.username), nil
	case "password":
		return []byte(a.password), nil
	}
	return nil, fmt.Errorf("알 수 없는 LOGIN 단계: %q", fromServer)
}
