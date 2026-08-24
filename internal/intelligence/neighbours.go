package intelligence

// Comparing every thought in a space with every other one.
//
// This is the largest cost of opening a canvas, and several other things do it
// too. At two thousand notes it is two million comparisons; it was measured at
// 163ms of a 243ms request, and clustering paid it twice over because the
// function it calls to load the notes had already done the same work and thrown
// the result away.
//
// Nothing here changes what is computed. The scores, the cutoff and the counts
// are the same numbers the plain loop produces — tested for equality rather
// than closeness, because the cutoff is compared against the very scores it was
// derived from, and a difference in the last bits moves a borderline pair
// across the line and changes an integer someone reads.

// sparse is the part of a vector that can contribute to a dot product.
//
// The local embedding is a char-gram histogram, so most of a note's dimensions
// are simply absent from its text: measured across a real space, 42 of 192
// carry a value. Multiplying the other 150 by zero is arithmetic whose answer
// is known in advance.
type sparse struct {
	indices []int32
	values  []float32
}

func compress(vector []float32) sparse {
	out := sparse{}
	for i, value := range vector {
		if value != 0 {
			out.indices = append(out.indices, int32(i))
			out.values = append(out.values, value)
		}
	}
	return out
}

// dot multiplies a compressed vector by a dense one.
//
// One side stays dense so the other can be walked directly rather than the two
// being merged: a merge would have to advance both index lists and compare,
// which costs more than the indexing it saves at these sizes.
func (s sparse) dot(dense []float32) float64 {
	// Accumulated in float64 and multiplied in float32, exactly as Cosine does.
	// Summing in float32 instead agreed to about eight decimal places, which
	// sounds close enough and is not.
	var total float64
	for k, index := range s.indices {
		if int(index) >= len(dense) {
			break
		}
		total += float64(s.values[k] * dense[index])
	}
	return clampSimilarity(total)
}

// Prepared is a set of vectors arranged so that comparing pairs of them costs
// as little as it can.
//
// Worth preparing once and passing around: the preparation is linear in the
// number of vectors, and everything it is handed to is quadratic.
type Prepared struct {
	dense    [][]float32
	sparse   []sparse
	pairs    []float64
	prepared bool
}

// Prepare compresses a set of vectors for repeated comparison.
func Prepare(vectors [][]float32) *Prepared {
	p := &Prepared{dense: vectors, sparse: make([]sparse, len(vectors)), prepared: true}
	for i, vector := range vectors {
		p.sparse[i] = compress(vector)
	}
	return p
}

// Len is how many vectors are in the set.
func (p *Prepared) Len() int {
	if p == nil {
		return 0
	}
	return len(p.dense)
}

// Score is how much two of them resemble each other. Identical to Cosine on the
// same pair.
func (p *Prepared) Score(i, j int) float64 {
	if p == nil || i < 0 || j < 0 || i >= len(p.dense) || j >= len(p.dense) {
		return 0
	}
	return p.sparse[i].dot(p.dense[j])
}

// pairScores is every pair once, in i<j order, computed on first use and kept.
//
// Kept because the two callers that need it both want it twice: once to derive
// a cutoff from the distribution, and again to judge each pair against it.
func (p *Prepared) pairScores() []float64 {
	if p.pairs != nil || len(p.dense) < 2 {
		return p.pairs
	}
	scores := make([]float64, 0, len(p.dense)*(len(p.dense)-1)/2)
	for i := range p.dense {
		row := p.sparse[i]
		for j := i + 1; j < len(p.dense); j++ {
			scores = append(scores, row.dot(p.dense[j]))
		}
	}
	p.pairs = scores
	return scores
}

// Cutoff is the line this set's own distribution draws, so that a score means
// the same thing whichever embedding produced the vectors.
func (p *Prepared) Cutoff(band Band, fallback float64) float64 {
	if p == nil || len(p.dense) < 2 {
		return fallback
	}
	return NewSimilarityScale(p.pairScores()).ThresholdOr(band, fallback)
}

// Counts is, for each vector, how many of the others resemble it closely enough
// to count, together with the cutoff that decided it.
func (p *Prepared) Counts(band Band, fallback float64) ([]int, float64) {
	if p == nil {
		return nil, fallback
	}
	counts := make([]int, len(p.dense))
	if len(p.dense) < 2 {
		return counts, fallback
	}
	scores := p.pairScores()
	cutoff := NewSimilarityScale(scores).ThresholdOr(band, fallback)

	// Similarity is symmetric, so one walk in the same order credits both sides
	// of each pair.
	at := 0
	for i := range p.dense {
		for j := i + 1; j < len(p.dense); j++ {
			if scores[at] >= cutoff {
				counts[i]++
				counts[j]++
			}
			at++
		}
	}
	return counts, cutoff
}

// NeighbourCounts prepares a set and counts it in one call, for callers that
// have nothing else to do with the prepared form.
func NeighbourCounts(vectors [][]float32, band Band, fallback float64) ([]int, float64) {
	return Prepare(vectors).Counts(band, fallback)
}
