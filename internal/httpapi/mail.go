package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/mail"
	"github.com/hkjang/umm/internal/store"
)

/*
Mail notifications: the five things somebody in umm is actually waiting for.

The rule for what earns a mail is one sentence — if this mail does not
arrive, somebody loses something or keeps refreshing a screen. That gives:

  - a review request reaching the people who can decide it (the requester is
    blocked until one of them does);
  - the decision reaching the requester (the one mail that ends the
    refreshing);
  - a space shared with somebody (until they know, the sharer waits for them
    to show up);
  - a name called in a comment (a question with their name on it);
  - a comment on somebody's own thought (addressed to what they wrote).

"Something changed" is not on the list, and the nightly Dream is not either:
nobody is waiting for it. Every hook here runs after the request has done its
work and hands off to a background sender, so a dead relay costs the request
nothing. Nobody is told about their own action, and the recipient sets for one
action never overlap, so one action is one mail per person.
*/

// notifyMail hands one notification to the mail service, if there is one.
// Every caller is on a request path and has already answered; nothing here
// can change that answer.
func (s *Server) notifyMail(ctx context.Context, notification mail.Notification, actor uuid.UUID, recipients []uuid.UUID) {
	if s.Mail == nil || len(recipients) == 0 {
		return
	}
	s.Mail.Notify(context.WithoutCancel(ctx), notification, actor, recipients)
}

// mailApprovalRequested tells the reviewers. Both places a request is born —
// the review endpoint and a share that the workflow holds for review — end
// here, so the reviewers learn about both the same way.
func (s *Server) mailApprovalRequested(ctx context.Context, requester store.User, action, subject, comment string) {
	if s.Mail == nil {
		return
	}
	reviewers, err := s.Store.ApprovalReviewers(ctx, requester.TeamID)
	if err != nil {
		return
	}
	s.notifyMail(ctx, mail.ApprovalRequested(requester.DisplayName, action, subject, comment), requester.ID, reviewers)
}

// mailApprovalDecided tells the requester.
func (s *Server) mailApprovalDecided(ctx context.Context, reviewer store.User, requesterID uuid.UUID, action, subject, decision, comment string) {
	s.notifyMail(ctx, mail.ApprovalDecided(reviewer.DisplayName, action, subject, decision, comment), reviewer.ID, []uuid.UUID{requesterID})
}

// mailSpaceShared tells the person the space was shared with.
func (s *Server) mailSpaceShared(ctx context.Context, actor store.User, spaceID, targetID uuid.UUID, permission string) {
	if s.Mail == nil {
		return
	}
	s.notifyMail(ctx, mail.SpaceShared(actor.DisplayName, s.spaceName(ctx, spaceID), permission, spaceID), actor.ID, []uuid.UUID{targetID})
}

// mailComment tells whoever the comment reached. The store has already
// decided who that is — the people named with @, and the author of the
// thought when they were not named and may see the space — and wrote an
// in-app notification for each; the mail follows those rows exactly, so the
// two channels can never disagree about who was told.
func (s *Server) mailComment(ctx context.Context, actor store.User, spaceID, noteID, commentID uuid.UUID, body string) {
	if s.Mail == nil {
		return
	}
	rows, err := s.Store.Pool.Query(ctx, `SELECT user_id,kind FROM notifications WHERE resource_type='note' AND resource_id=$1 AND metadata->>'commentId'=$2`, noteID, commentID.String())
	if err != nil {
		return
	}
	defer rows.Close()
	var mentioned, authors []uuid.UUID
	for rows.Next() {
		var userID uuid.UUID
		var kind string
		if rows.Scan(&userID, &kind) != nil {
			return
		}
		switch kind {
		case "mention":
			mentioned = append(mentioned, userID)
		case "comment":
			authors = append(authors, userID)
		}
	}
	if rows.Err() != nil || (len(mentioned) == 0 && len(authors) == 0) {
		return
	}
	spaceName := s.spaceName(ctx, spaceID)
	s.notifyMail(ctx, mail.Mentioned(actor.DisplayName, spaceName, spaceID, noteID, body), actor.ID, mentioned)
	s.notifyMail(ctx, mail.CommentPosted(actor.DisplayName, spaceName, spaceID, noteID, body), actor.ID, authors)
}

func (s *Server) spaceName(ctx context.Context, spaceID uuid.UUID) string {
	var name string
	if err := s.Store.Pool.QueryRow(ctx, `SELECT name FROM spaces WHERE id=$1`, spaceID).Scan(&name); err != nil {
		return "이름 없는 공간"
	}
	return name
}

// approvalSubject names what a request is about, the way the review screen
// does: the space, when the request is about one.
func (s *Server) approvalSubject(ctx context.Context, resourceType string, resourceID uuid.UUID) string {
	if resourceType != "space" {
		return ""
	}
	var name string
	if err := s.Store.Pool.QueryRow(ctx, `SELECT name FROM spaces WHERE id=$1`, resourceID).Scan(&name); err != nil {
		return ""
	}
	return name
}

// adminMailDeliveries is the ledger: what left the building, newest first.
func (s *Server) adminMailDeliveries(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	page, err := s.Store.ListMailDeliveries(r.Context(), r.URL.Query().Get("status"), limit)
	if err != nil {
		writeError(w, 500, "발송 기록을 불러오지 못했습니다.")
		return
	}
	writeJSON(w, 200, page)
}

// adminSendTestMail sends one real mail with the saved settings and reports
// what the relay said. Relay settings are rarely right the first time, and
// the first notification somebody depends on is the wrong place to find out.
// The recipient defaults to the administrator's own address.
func (s *Server) adminSendTestMail(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Recipient string `json:"recipient"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "요청 형식이 올바르지 않습니다.")
		return
	}
	if s.Mail == nil {
		writeError(w, 503, "메일 서비스가 준비되지 않았습니다.")
		return
	}
	p := principal(r)
	recipient := strings.TrimSpace(body.Recipient)
	if recipient == "" {
		recipient = strings.TrimSpace(p.User.Email)
	}
	if !strings.Contains(recipient, "@") {
		writeError(w, 400, "받는 사람 메일 주소를 적어 주세요. 계정에 메일 주소가 없으면 비워 둘 수 없습니다.")
		return
	}
	err := s.Mail.SendNow(r.Context(), mail.TestMessage(), p.User.ID, recipient)
	s.Store.Audit(r.Context(), &p.User.ID, "mail.test", "settings", mail.SettingKey, map[string]any{"recipient": recipient, "sent": err == nil})
	if err != nil {
		status := 502
		if errors.Is(err, mail.ErrInvalid) {
			status = 400
		}
		// The relay's own words: this is the one screen where "STARTTLS failed"
		// is the useful answer and "could not send" is not.
		writeError(w, status, "시험 발송 실패: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"sent": true, "recipient": recipient})
}
