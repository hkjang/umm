package presentation

import "sort"

/*
Fitting a talk into the time there is.

A space of two thousand thoughts compiles to a few hundred slides even after
grouping, and nobody gives a three-hundred-slide talk. The person needs the
twenty that matter.

Which twenty is a judgement, and umm already holds most of the evidence for it:
the graph. A thought five others argue for is more load-bearing than one nobody
connected. A disagreement someone bothered to record is the slide a summary of
the same notes would never produce. A question they marked is what a part of the
talk is about. None of that is guesswork — it is what they drew.

So this ranks rather than asks a model. Three reasons, in the order they matter:

  - It is deterministic. The same space and the same target give the same talk,
    which is what makes a preview worth reading.
  - It works with no gateway configured, which is most installations.
  - It is explainable. "This was left out because nothing connects to it" is
    something a person can disagree with and act on; "the model chose these" is
    not.

A model could weigh a thought against a theme in a way a graph cannot, and that
is a real thing this does not do. It is a smaller loss than it sounds: the
person can already say which thoughts to build from, and doing that is a better
answer than having a model guess at what they meant.

Nothing is deleted and nothing is silent. What does not fit is counted and
named, the way thoughts held back from analysis already are, because dropping a
thought out of somebody's own space without saying so is the one thing this must
never do.
*/

// keepAlways is the slide a talk should not lose first.
//
// A comparison holds two thoughts that contradict each other. umm records
// disagreements instead of resolving them by deleting a side, and that slide is
// the one a summary of the same notes would never produce — so it is the last
// thing to cut, not the first.
func keepAlways(slide Slide) bool { return slide.Role == RoleComparison }

// weight is how much a slide is carrying.
//
// Every part of it is something the person did: how many of their thoughts
// reached this slide, whether they marked it a question, whether they recorded
// a disagreement. Nothing here reads the words.
func weight(slide Slide) int {
	score := len(slide.From)
	if slide.Role == RoleSection {
		// A question they marked is what the slides after it are answering.
		score += 4
	}
	if slide.Role == RoleComparison {
		score += 6
	}
	return score
}

// fit cuts a talk down to at most max slides, keeping the ones carrying most.
//
// The kept slides stay in the order they were in: this decides what is in the
// talk, never what order it is in. That order is a follows chain or the layout
// the person made, and rearranging it would override what they said.
//
// What did not fit is recorded on the storyline rather than returned, so that
// running this twice — once on the compiled slides, again after part headings
// were added — accumulates instead of forgetting the first pass. Returns how
// many slides were removed.
func fit(story *Storyline, max int) int {
	if story == nil || max <= 0 || len(story.Slides) <= max {
		return 0
	}

	// Ranked on a copy of the indexes, so the slides themselves never move.
	order := make([]int, len(story.Slides))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		x, y := story.Slides[order[a]], story.Slides[order[b]]
		if keepAlways(x) != keepAlways(y) {
			return keepAlways(x)
		}
		if wx, wy := weight(x), weight(y); wx != wy {
			return wx > wy
		}
		// A tie goes to whichever comes first in the talk, so the opening
		// survives a tie with the middle.
		return order[a] < order[b]
	})

	keep := make([]bool, len(story.Slides))
	for _, index := range order[:max] {
		keep[index] = true
	}

	kept := make([]Slide, 0, max)
	removed := 0
	for index, slide := range story.Slides {
		if keep[index] {
			kept = append(kept, slide)
			continue
		}
		removed++
		story.Trimmed = append(story.Trimmed, slide.From...)
	}
	story.Slides = kept
	story.TrimmedSlides += removed
	return removed
}
