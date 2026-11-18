package imagecaptcha

import (
	"bytes"
	"encoding/base64"
	"sync"
	"time"

	"github.com/dchest/captcha"
)

const digits = 4
const challengeLifetime = 10 * time.Minute
const maxChallenges = 1000

var registerStore sync.Once

// Service keeps short-lived, one-use image challenges in the current API process.
type Service struct{}

func New() *Service {
	registerStore.Do(func() { captcha.SetCustomStore(newChallengeStore(time.Now, maxChallenges)) })
	return &Service{}
}

func (*Service) Generate() (string, string, error) {
	id := captcha.NewLen(digits)
	var image bytes.Buffer
	if err := captcha.WriteImage(&image, id, 220, 72); err != nil {
		return "", "", err
	}
	return id, "data:image/png;base64," + base64.StdEncoding.EncodeToString(image.Bytes()), nil
}

func (*Service) Verify(id, answer string) bool {
	if id == "" {
		return false
	}
	candidate := []byte{255}
	if len(answer) == digits {
		candidate = make([]byte, digits)
		for i := range answer {
			if answer[i] < '0' || answer[i] > '9' {
				candidate = []byte{255}
				break
			}
			candidate[i] = answer[i] - '0'
		}
	}
	return captcha.Verify(id, candidate)
}
