package httpapi

import (
	"fmt"
	"strings"

	"github.com/hkjang/umm/internal/textutil"
)

// maxDispositionStemBytes bounds the part of a download name that comes from a
// person. A space name has no length of its own, and the whole name is spelled
// out twice in the header, so an unbounded one turns a download into a header
// nobody can read. The same 120 bytes an attachment label gets.
const maxDispositionStemBytes = 120

// attachmentDisposition names a downloaded file.
//
// The name is built from a space's name, which is a person's words: it holds
// quotation marks and Korean as readily as anything else, and the plain
// `filename="..."` form survives neither. A `"` closes the quoted string early
// and the rest of the name is read as header syntax — in a shared space that
// means whoever named it decides what everyone else's download is called. Raw
// non-ASCII bytes are simply undefined there, and every browser guesses a
// different encoding, so a Korean name arrives mangled in a different way for
// each person.
//
// RFC 6266 answers both: filename* carries the real name percent-encoded as
// UTF-8, and the quoted filename stays behind as an ASCII-only fallback for
// clients that predate it. Clients that understand both are required to prefer
// filename*.
//
// The characters removed here are the ones store.safeFilename removes from an
// attachment label, and for the same reason — a name that only labels on one
// screen becomes a path the moment somebody writes it to disk.
func attachmentDisposition(stem, extension string) string {
	stem = textutil.LimitUTF8Bytes(dispositionSafe(stem), maxDispositionStemBytes)
	if stem == "" {
		stem = "umm"
	}
	name := stem + extension
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, asciiFallback(name), rfc5987Escape(name))
}

// dispositionSafe drops what must never reach a file name, whichever of the
// two forms the client reads: separators, quotes and control characters.
func dispositionSafe(name string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' || r == '"' {
			return -1
		}
		return r
	}, name))
}

// asciiFallback is what a client that does not read filename* is given. A run
// of runes it could not have spelled becomes one dash rather than disappearing,
// so the name still shows where the missing words were — and whitespace joins
// that run, because a name half in Korean would otherwise come out as dashes
// with the gaps between the words still in them.
//
// A name with nothing left to spell falls back to a fixed one. This is the
// worse of the two names on purpose; the client that reads filename* gets what
// the space is actually called.
func asciiFallback(name string) string {
	var out strings.Builder
	previousDash := false
	for _, r := range name {
		if r > 0x7e || r == '-' || r == ' ' || r == '\t' {
			if !previousDash {
				out.WriteRune('-')
				previousDash = true
			}
			continue
		}
		previousDash = false
		out.WriteRune(r)
	}
	trimmed := strings.Trim(out.String(), "-")
	if trimmed == "" || trimmed == extensionOf(name) {
		return "umm-space" + extensionOf(name)
	}
	return trimmed
}

func extensionOf(name string) string {
	if dot := strings.LastIndexByte(name, '.'); dot >= 0 {
		return name[dot:]
	}
	return ""
}

// rfc5987Escape percent-encodes everything outside RFC 5987 attr-char. It works
// on bytes so that a multi-byte rune comes out as the UTF-8 the charset names.
func rfc5987Escape(value string) string {
	const unreserved = "!#$&+-.^_`|~"
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			strings.IndexByte(unreserved, c) >= 0:
			out.WriteByte(c)
		default:
			fmt.Fprintf(&out, "%%%02X", c)
		}
	}
	return out.String()
}
