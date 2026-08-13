package cryptoutil

import "testing"

func TestCipherRoundTripAndTamper(t *testing.T) {
	c, err := New([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := c.Encrypt("client-secret")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := c.Decrypt(sealed)
	if err != nil || plain != "client-secret" {
		t.Fatalf("round trip failed: %q %v", plain, err)
	}
	last := sealed[len(sealed)-1]
	replacement := byte('A')
	if last == 'A' {
		replacement = 'B'
	}
	if _, err = c.Decrypt(sealed[:len(sealed)-1] + string(replacement)); err == nil {
		t.Fatal("tampered ciphertext must fail")
	}
}
