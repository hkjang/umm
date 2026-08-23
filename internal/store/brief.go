package store

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/intelligence"
)

// What happened while you were not looking.
//
// The brief only counts things umm actually produced. It is tempting to show a
// row for contradictions or for thoughts whose importance rose overnight, but
// umm detects neither, and a zero next to a category it never examined reads as
// "there are none" rather than "nobody looked". So the brief also carries what
// it could not check and why: an empty duplicates list means something different
// depending on whether the backend was fit to find them.

// BriefGroup is a count of one kind of thing waiting.
type BriefGroup struct {
	Kind  string `json:"kind"`
	Count int    `json:"count"`
}

// DuplicatePair is two thoughts that look like the same thought written twice.
type DuplicatePair struct {
	SpaceID uuid.UUID `json:"spaceId"`
	Space   string    `json:"space"`
	First   Note      `json:"first"`
	Second  Note      `json:"second"`
	Score   float64   `json:"score"`
}

// BriefSkip records something umm did not look for, and why.
type BriefSkip struct {
	Kind   string `json:"kind"`
	Reason string `json:"reason"`
}

const (
	// SkipBackendNotSemantic: the active embedding scores shared vocabulary above
	// shared meaning, so any answer would be about wording rather than substance.
	SkipBackendNotSemantic = "backend-not-semantic"
	// SkipDisabled: an administrator turned the underlying feature off.
	SkipDisabled = "disabled"
)

// MorningBrief summarises what is waiting for a person.
type MorningBrief struct {
	Since time.Time `json:"since"`
	// Dreams waiting to be read, grouped by what kind of dream they are.
	Dreams []BriefGroup `json:"dreams"`
	// Suggestions is the number of connections umm proposed and nobody has
	// answered yet.
	Suggestions int `json:"suggestions"`
	// Unfiled is how many captured thoughts are still sitting in the inbox.
	Unfiled int `json:"unfiled"`
	// Duplicates are pairs that look like the same thought written twice.
	Duplicates []DuplicatePair `json:"duplicates"`
	// Contradictions are disagreements someone recorded. umm does not detect
	// them: these are connections a person or an agent drew. The interface shows
	// nothing at all when the list is empty, because a zero here would read as
	// "this workspace has none" when it means "nobody has marked any".
	Contradictions []Contradiction `json:"contradictions"`
	// Questions marked open with nothing recorded as answering them. Like
	// contradictions, both halves are marked rather than inferred, so an empty
	// list means nothing is marked open — not that everything is answered.
	Questions []OpenQuestion `json:"questions"`
	// Skipped says what umm did not examine, so an empty list above is not read
	// as an all-clear.
	Skipped []BriefSkip `json:"skipped"`
	// Quiet is true when there is genuinely nothing to report and nothing was
	// skipped — the only case where "nothing happened" is the whole story.
	Quiet bool `json:"quiet"`
}

// maxDuplicatePairs bounds what one brief will show. A workspace that has been
// duplicating for months should produce a readable list, not a wall.
const maxDuplicatePairs = 10

// MorningBrief gathers everything waiting since the given time.
func (s *Store) MorningBrief(ctx context.Context, userID uuid.UUID, since time.Time) (MorningBrief, error) {
	brief := MorningBrief{Since: since, Dreams: []BriefGroup{}, Duplicates: []DuplicatePair{},
		Contradictions: []Contradiction{}, Questions: []OpenQuestion{}, Skipped: []BriefSkip{}}

	rows, err := s.Pool.Query(ctx, `
		SELECT dream_type, count(*)
		FROM dream_notes
		WHERE user_id=$1 AND generated_at >= $2 AND status IN ('created','exposed')
		GROUP BY dream_type ORDER BY count(*) DESC, dream_type`, userID, since)
	if err != nil {
		return MorningBrief{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var group BriefGroup
		if err := rows.Scan(&group.Kind, &group.Count); err != nil {
			return MorningBrief{}, err
		}
		brief.Dreams = append(brief.Dreams, group)
	}
	if err = rows.Err(); err != nil {
		return MorningBrief{}, err
	}

	// Proposals nobody has answered. Scoped to spaces this person can reach, so
	// a shared workspace does not leak counts from one they cannot see.
	if err = s.Pool.QueryRow(ctx, `
		SELECT count(*) FROM note_edges e
		JOIN spaces sp ON sp.id=e.space_id
		LEFT JOIN space_members m ON m.space_id=sp.id AND m.user_id=$1
		WHERE e.origin='auto' AND (sp.owner_id=$1 OR m.user_id=$1)`, userID).Scan(&brief.Suggestions); err != nil {
		return MorningBrief{}, err
	}

	if err = s.Pool.QueryRow(ctx, `
		SELECT count(*) FROM notes n
		JOIN spaces sp ON sp.id=n.space_id
		WHERE sp.owner_id=$1 AND sp.is_inbox AND n.deleted_at IS NULL`, userID).Scan(&brief.Unfiled); err != nil {
		return MorningBrief{}, err
	}

	// Capped for the same reason as duplicates: a brief is a glance, not a report.
	recorded, err := s.Contradictions(ctx, userID, nil)
	if err != nil {
		return MorningBrief{}, err
	}
	if len(recorded) > maxDuplicatePairs {
		recorded = recorded[:maxDuplicatePairs]
	}
	brief.Contradictions = recorded

	questions, err := s.OpenQuestions(ctx, userID, nil)
	if err != nil {
		return MorningBrief{}, err
	}
	if len(questions) > maxDuplicatePairs {
		questions = questions[:maxDuplicatePairs]
	}
	brief.Questions = questions

	duplicates, skip, err := s.duplicateThoughts(ctx, userID)
	if err != nil {
		return MorningBrief{}, err
	}
	brief.Duplicates = duplicates
	if skip != nil {
		brief.Skipped = append(brief.Skipped, *skip)
	}

	brief.Quiet = len(brief.Dreams) == 0 && brief.Suggestions == 0 && brief.Unfiled == 0 &&
		len(brief.Duplicates) == 0 && len(brief.Contradictions) == 0 &&
		len(brief.Questions) == 0 && len(brief.Skipped) == 0
	return brief, nil
}

// duplicateThoughts finds pairs that look like the same thought recorded twice.
//
// This is the one place umm uses an absolute similarity rather than a
// distribution-relative one, and it is deliberate. Every other threshold is
// relative because backends disagree about what "close" means; near-identical
// text lands at the top of any sane embedding space, and the two models measured
// agree on where. A relative rule would also fail here for a specific reason: a
// workspace full of duplicates moves its own distribution, so the duplicates stop
// looking unusual precisely when there are the most of them.
func (s *Store) duplicateThoughts(ctx context.Context, userID uuid.UUID) ([]DuplicatePair, *BriefSkip, error) {
	report, err := s.MeasureEmbeddingQuality(ctx, false)
	if err != nil {
		return []DuplicatePair{}, &BriefSkip{Kind: "duplicates", Reason: SkipBackendNotSemantic}, nil
	}
	if !report.Semantic {
		// The offline algorithm scores genuinely different sentences as high as
		// 0.889 while some real duplicates fall to 0.505 — the ranges overlap, so
		// anything it reported here would be about wording, not substance.
		return []DuplicatePair{}, &BriefSkip{Kind: "duplicates", Reason: SkipBackendNotSemantic}, nil
	}
	settings := s.IntelligenceSettings(ctx)
	spaces, err := s.ListSpaces(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	pairs := []DuplicatePair{}
	for _, space := range spaces {
		notes, _, listErr := s.ListNotes(ctx, userID, space.ID, "")
		if listErr != nil || len(notes) < 2 {
			continue
		}
		vectors := s.loadEmbeddings(ctx, notes)
		for i := 0; i < len(notes); i++ {
			for j := i + 1; j < len(notes); j++ {
				score := float64(intelligence.Cosine(vectors[notes[i].ID], vectors[notes[j].ID]))
				if score >= settings.DuplicateSimilarity {
					pairs = append(pairs, DuplicatePair{
						SpaceID: space.ID, Space: space.Name,
						First: notes[i], Second: notes[j], Score: score,
					})
				}
			}
		}
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].Score > pairs[j].Score })
	if len(pairs) > maxDuplicatePairs {
		pairs = pairs[:maxDuplicatePairs]
	}
	return pairs, nil, nil
}
