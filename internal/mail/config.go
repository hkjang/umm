package mail

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

// SettingKey is the app_settings row the administrator's screen edits. The
// field names below are the in-house standard's keys with the section prefix
// dropped: `mail.smtp_host` is `smtp_host` in the `mail` row.
const SettingKey = "mail"

// Defaults aim at what an internal relay usually is: port 25, no credentials,
// no TLS unless the server offers it. Authentication and encryption are the
// options, not the baseline.
const (
	DefaultPort     = 25
	DefaultSecurity = "auto"
	DefaultTimeout  = 10 * time.Second
	DefaultFromName = "umm"
)

// Event names. Each has a switch in the settings row (`notify_<switch>`), so an
// administrator can silence one kind without silencing the rest.
const (
	EventApprovalRequested = "approval.requested"
	EventApprovalDecided   = "approval.decided"
	EventSpaceShared       = "space.shared"
	EventMention           = "comment.mention"
	EventComment           = "comment.created"
	EventTest              = "test"
)

// eventSwitches maps an event to the settings field that turns it off. The
// test message has no switch: it is sent only by an administrator, on purpose.
var eventSwitches = map[string]string{
	EventApprovalRequested: "notify_approval_request",
	EventApprovalDecided:   "notify_approval_decision",
	EventSpaceShared:       "notify_space_shared",
	EventMention:           "notify_mention",
	EventComment:           "notify_comment",
}

// EventSwitches lists the switch fields in a stable order, for the screen and
// the guide.
func EventSwitches() []string {
	return []string{
		eventSwitches[EventApprovalRequested],
		eventSwitches[EventApprovalDecided],
		eventSwitches[EventSpaceShared],
		eventSwitches[EventMention],
		eventSwitches[EventComment],
	}
}

// Settings is the `mail` row as it is stored. The password arrives encrypted
// ("enc:…") and is never decoded here — the store decodes it on the way into a
// Config, and the settings API masks it on the way out.
type Settings struct {
	Enabled        bool   `json:"enabled"`
	SMTPHost       string `json:"smtp_host"`
	SMTPPort       int    `json:"smtp_port"`
	Security       string `json:"security"`
	SkipTLSVerify  bool   `json:"skip_tls_verify"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	FromAddress    string `json:"from_address"`
	FromName       string `json:"from_name"`
	BaseURL        string `json:"base_url"`
	TimeoutSeconds int    `json:"timeout_seconds"`
	// Notify holds the notify_* switches by their suffix. A switch the row does
	// not mention is on, so adding an event never needs a settings change first.
	Notify map[string]bool `json:"-"`
}

// UnmarshalJSON reads the fixed fields and then collects every `notify_*`
// boolean, so the switches are one loop here rather than one field each.
func (s *Settings) UnmarshalJSON(raw []byte) error {
	type plain Settings
	var fixed plain
	if err := json.Unmarshal(raw, &fixed); err != nil {
		return err
	}
	var all map[string]any
	if err := json.Unmarshal(raw, &all); err != nil {
		return err
	}
	fixed.Notify = map[string]bool{}
	for key, value := range all {
		if !strings.HasPrefix(key, "notify_") {
			continue
		}
		if enabled, ok := value.(bool); ok {
			fixed.Notify[strings.TrimPrefix(key, "notify_")] = enabled
		}
	}
	*s = Settings(fixed)
	return nil
}

// Validate is what the settings screen is held to. It is stricter than what
// sending needs — a relay without a host can be saved while mail is off — so
// an administrator finds out about a missing value when they save it, not
// from a failed delivery days later.
func (s Settings) Validate() error {
	host := strings.TrimSpace(s.SMTPHost)
	if s.Enabled && host == "" {
		return errors.New("메일을 켜려면 SMTP 릴레이 주소가 필요합니다")
	}
	if strings.ContainsAny(host, " /:@") {
		return errors.New("SMTP 릴레이 주소는 호스트 이름이나 IP 주소만 적습니다 (포트는 따로)")
	}
	if s.SMTPPort != 0 && (s.SMTPPort < 1 || s.SMTPPort > 65535) {
		return errors.New("SMTP 포트는 1~65535 사이여야 합니다")
	}
	switch strings.ToLower(strings.TrimSpace(s.Security)) {
	case "", "auto", "none", "starttls", "tls":
	default:
		return errors.New("보안 방식은 auto · none · starttls · tls 중 하나여야 합니다")
	}
	if from := strings.TrimSpace(s.FromAddress); from != "" && !looksLikeAddress(from) {
		return errors.New("보내는 사람 주소가 메일 주소 형식이 아닙니다")
	}
	if s.TimeoutSeconds != 0 && (s.TimeoutSeconds < 1 || s.TimeoutSeconds > 120) {
		return errors.New("제한 시간은 1~120초 사이여야 합니다")
	}
	if base := strings.TrimSpace(s.BaseURL); base != "" && !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return errors.New("메일 속 링크 주소는 http(s):// 로 시작해야 합니다")
	}
	return nil
}

// Config is what sending reads: the row with defaults filled in, the password
// in the clear, and the link base resolved. It never leaves the process.
type Config struct {
	Enabled     bool
	Host        string
	Port        int
	Security    string
	SkipVerify  bool
	Username    string
	Password    string
	FromAddress string
	FromName    string
	BaseURL     string
	Timeout     time.Duration
	Notify      map[string]bool
}

// Config fills the defaults in. password is the decrypted secret; fallbackBase
// is the service's public URL, used for links when the mail row has none so
// the same address is not typed twice.
func (s Settings) Config(password, fallbackBase string) Config {
	config := Config{
		Enabled:     s.Enabled,
		Host:        strings.TrimSpace(s.SMTPHost),
		Port:        s.SMTPPort,
		Security:    strings.ToLower(strings.TrimSpace(s.Security)),
		SkipVerify:  s.SkipTLSVerify,
		Username:    strings.TrimSpace(s.Username),
		Password:    password,
		FromAddress: strings.TrimSpace(s.FromAddress),
		FromName:    strings.TrimSpace(s.FromName),
		BaseURL:     strings.TrimRight(strings.TrimSpace(s.BaseURL), "/"),
		Timeout:     time.Duration(s.TimeoutSeconds) * time.Second,
		Notify:      map[string]bool{},
	}
	for key, enabled := range s.Notify {
		config.Notify[key] = enabled
	}
	if config.Port == 0 {
		config.Port = DefaultPort
	}
	if config.Security == "" {
		config.Security = DefaultSecurity
	}
	// The implicit-TLS port needs no extra setting.
	if config.Security == DefaultSecurity && config.Port == 465 {
		config.Security = "tls"
	}
	if config.Timeout <= 0 {
		config.Timeout = DefaultTimeout
	}
	if config.FromName == "" {
		config.FromName = DefaultFromName
	}
	if config.FromAddress == "" && config.Host != "" {
		config.FromAddress = "umm@" + config.Host
	}
	if config.BaseURL == "" {
		config.BaseURL = strings.TrimRight(strings.TrimSpace(fallbackBase), "/")
	}
	return config
}

// Allows reports whether an event may be sent. Unknown events and the test
// message are always allowed; only a switch set to false silences one.
func (c Config) Allows(event string) bool {
	field, known := eventSwitches[event]
	if !known {
		return true
	}
	if enabled, set := c.Notify[strings.TrimPrefix(field, "notify_")]; set {
		return enabled
	}
	return true
}

// validate is the sending-time check: what a delivery cannot do without.
func (c Config) validate() error {
	if c.Host == "" {
		return fmt.Errorf("%w: SMTP 릴레이 주소(smtp_host)가 비어 있습니다", ErrInvalid)
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("%w: SMTP 포트가 1~65535 범위를 벗어났습니다", ErrInvalid)
	}
	if !looksLikeAddress(c.FromAddress) {
		return fmt.Errorf("%w: 보내는 사람 주소(from_address)가 메일 주소가 아닙니다", ErrInvalid)
	}
	switch c.Security {
	case "auto", "none", "starttls", "tls":
	default:
		return fmt.Errorf("%w: 보안 방식 %q 는 auto · none · starttls · tls 중 하나가 아닙니다", ErrInvalid, c.Security)
	}
	return nil
}

func (c Config) endpoint() string { return net.JoinHostPort(c.Host, fmt.Sprint(c.Port)) }

// Sender is the RFC 5322 From value.
func (c Config) Sender() string {
	if c.FromName != "" {
		return fmt.Sprintf("%s <%s>", c.FromName, c.FromAddress)
	}
	return c.FromAddress
}

// looksLikeAddress is the whole of the address check: one @ with something on
// both sides and no whitespace. A relay does the real validation, and refusing
// an unusual but valid local part here would only stop mail that would have
// been delivered.
func looksLikeAddress(value string) bool {
	at := strings.Index(value, "@")
	if at <= 0 || at == len(value)-1 {
		return false
	}
	if strings.ContainsAny(value, " \t\r\n<>,") {
		return false
	}
	return !strings.Contains(value[at+1:], "@")
}
