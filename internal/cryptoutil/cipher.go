package cryptoutil

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
)

type Cipher struct{ aead cipher.AEAD }

func New(key []byte) (*Cipher, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

func (c *Cipher) Encrypt(plain string) (string, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nonce, nonce, []byte(plain), []byte("umm:v1"))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (c *Cipher) Decrypt(encoded string) (string, error) {
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(data) < c.aead.NonceSize() {
		return "", errors.New("invalid encrypted value")
	}
	nonce, data := data[:c.aead.NonceSize()], data[c.aead.NonceSize():]
	plain, err := c.aead.Open(nil, nonce, data, []byte("umm:v1"))
	if err != nil {
		return "", errors.New("unable to decrypt value")
	}
	return string(plain), nil
}

func Digest(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}
