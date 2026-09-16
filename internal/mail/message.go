package mail

import (
	"fmt"
	"mime"
	"strings"
	"time"

	"github.com/google/uuid"
)

// compose writes the MIME message. The subject and the display name are
// Q-encoded so a relay or a client that predates UTF-8 headers still shows
// Korean; the body is UTF-8 with CRLF line ends.
func compose(config Config, message Message, now time.Time) string {
	var out strings.Builder
	out.WriteString("From: " + encodeSender(config.Sender()) + "\r\n")
	out.WriteString("To: " + strings.TrimSpace(message.To) + "\r\n")
	out.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", message.Subject) + "\r\n")
	out.WriteString("Date: " + now.Format(time.RFC1123Z) + "\r\n")
	out.WriteString("MIME-Version: 1.0\r\n")
	out.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	out.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	// Auto-Submitted stops out-of-office replies and mailing lists from
	// answering a notification.
	out.WriteString("Auto-Submitted: auto-generated\r\n")
	out.WriteString("X-Umm-Notification: 1\r\n")
	out.WriteString("\r\n")
	out.WriteString(wireBody(message.Body))
	return out.String()
}

func encodeSender(sender string) string {
	open := strings.LastIndex(sender, "<")
	if open <= 0 {
		return sender
	}
	return mime.QEncoding.Encode("utf-8", strings.TrimSpace(sender[:open])) + " " + sender[open:]
}

// wireBody normalises line ends. The dot-stuffing that keeps a line of "."
// from ending DATA early is done by the writer net/smtp hands back from
// Data(); doing it here as well would put two dots in front of every such
// line.
func wireBody(body string) string {
	body = strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n")
	if !strings.HasSuffix(body, "\r\n") {
		body += "\r\n"
	}
	return body
}

// Notification is one event's mail before the recipients are resolved. Lines
// is the body; Link is the path inside umm the reader should open, made
// absolute with the configured base URL when there is one.
type Notification struct {
	Event   string
	Subject string
	Lines   []string
	Link    string
	SpaceID uuid.UUID
}

// Render is the body: the lines, the link when a base URL makes one possible,
// and a footer that says why the mail arrived and where to turn it off.
func (n Notification) Render(config Config) string {
	lines := append([]string{}, n.Lines...)
	if link := n.absoluteLink(config); link != "" {
		lines = append(lines, "", "바로 열기: "+link)
	}
	lines = append(lines, "", "—", "이 메일은 umm 이 관리자가 켜 둔 알림 설정에 따라 자동으로 보낸 것입니다. 답장은 읽히지 않습니다.")
	return strings.Join(lines, "\n")
}

func (n Notification) absoluteLink(config Config) string {
	if n.Link == "" || config.BaseURL == "" {
		return ""
	}
	return config.BaseURL + "/" + strings.TrimLeft(n.Link, "/")
}

// ActionLabel is the approval action as the review screen names it.
func ActionLabel(action string) string {
	switch action {
	case "space_share":
		return "팀 공간 공유"
	case "export":
		return "외부 내보내기"
	}
	return action
}

// ApprovalRequested goes to the people who can decide. Somebody is blocked
// until one of them does, and without this they would only find the request
// by opening the review screen on a hunch.
func ApprovalRequested(requester, action, subject, comment string) Notification {
	lines := []string{fmt.Sprintf("%s 님이 %s 검토를 요청했습니다.", requester, ActionLabel(action))}
	if strings.TrimSpace(subject) != "" {
		lines = append(lines, "대상: "+subject)
	}
	if strings.TrimSpace(comment) != "" {
		lines = append(lines, "", quote(comment))
	}
	lines = append(lines, "", "검토 · 승인 화면에서 승인하거나 반려할 수 있습니다. 결정할 때까지 요청한 사람은 기다립니다.")
	return Notification{
		Event:   EventApprovalRequested,
		Subject: fmt.Sprintf("[umm] 검토 요청: %s · %s", ActionLabel(action), requester),
		Lines:   lines,
		Link:    "/approvals",
	}
}

// ApprovalDecided tells the requester what was decided — the one mail that
// ends the refreshing.
func ApprovalDecided(reviewer, action, subject, decision, comment string) Notification {
	verdict := "반려되었습니다"
	if decision == "approved" {
		verdict = "승인되었습니다"
	}
	lines := []string{fmt.Sprintf("%s 검토 요청이 %s. (검토: %s)", ActionLabel(action), verdict, reviewer)}
	if strings.TrimSpace(subject) != "" {
		lines = append(lines, "대상: "+subject)
	}
	if strings.TrimSpace(comment) != "" {
		lines = append(lines, "", quote(comment))
	}
	return Notification{
		Event:   EventApprovalDecided,
		Subject: fmt.Sprintf("[umm] 검토 결과: %s · %s", ActionLabel(action), strings.TrimSuffix(verdict, "되었습니다")),
		Lines:   lines,
		Link:    "/approvals",
	}
}

// SpaceShared tells somebody a space is now theirs to open. Until they know,
// the person who shared it is waiting for them to show up.
func SpaceShared(actor, spaceName, permission string, spaceID uuid.UUID) Notification {
	return Notification{
		Event:   EventSpaceShared,
		Subject: fmt.Sprintf("[umm] %s 님이 '%s' 공간을 공유했습니다", actor, spaceName),
		Lines: []string{
			fmt.Sprintf("%s 님이 '%s' 공간을 공유했습니다.", actor, spaceName),
			"권한: " + permissionLabel(permission),
		},
		Link:    "/space/" + spaceID.String(),
		SpaceID: spaceID,
	}
}

// Mentioned goes to somebody named with @ in a comment: a question with their
// name on it, waiting for them.
func Mentioned(actor, spaceName string, spaceID, noteID uuid.UUID, body string) Notification {
	return Notification{
		Event:   EventMention,
		Subject: fmt.Sprintf("[umm] %s 님이 댓글에서 회원님을 언급했습니다", actor),
		Lines: []string{
			fmt.Sprintf("%s 님이 '%s' 공간의 생각에 단 댓글에서 회원님을 언급했습니다.", actor, spaceName),
			"",
			quote(body),
		},
		Link:    noteLink(spaceID, noteID),
		SpaceID: spaceID,
	}
}

// CommentPosted goes to the author of the thought. The comment is addressed
// to what they wrote, and the person who wrote it is waiting for an answer.
func CommentPosted(actor, spaceName string, spaceID, noteID uuid.UUID, body string) Notification {
	return Notification{
		Event:   EventComment,
		Subject: fmt.Sprintf("[umm] %s 님이 회원님의 생각에 댓글을 남겼습니다", actor),
		Lines: []string{
			fmt.Sprintf("%s 님이 '%s' 공간에 있는 회원님의 생각에 댓글을 남겼습니다.", actor, spaceName),
			"",
			quote(body),
		},
		Link:    noteLink(spaceID, noteID),
		SpaceID: spaceID,
	}
}

// TestMessage is what the administrator's button sends.
func TestMessage() Notification {
	return Notification{
		Event:   EventTest,
		Subject: "[umm] SMTP 시험 발송",
		Lines: []string{
			"umm 관리 화면에서 보낸 시험 메일입니다.",
			"이 메일이 도착했다면 릴레이 설정이 맞습니다.",
		},
	}
}

func noteLink(spaceID, noteID uuid.UUID) string {
	return "/space/" + spaceID.String() + "?note=" + noteID.String()
}

func permissionLabel(permission string) string {
	switch permission {
	case "view":
		return "보기"
	case "edit":
		return "편집"
	case "manage":
		return "관리"
	}
	return permission
}

// quote indents a comment as a quotation and stops at 500 characters: the
// mail should say what was said, not carry the whole thread.
func quote(body string) string {
	trimmed := strings.TrimSpace(body)
	if runes := []rune(trimmed); len(runes) > 500 {
		trimmed = string(runes[:500]) + "…"
	}
	lines := strings.Split(trimmed, "\n")
	for index, line := range lines {
		lines[index] = "> " + strings.TrimRight(line, "\r")
	}
	return strings.Join(lines, "\n")
}
