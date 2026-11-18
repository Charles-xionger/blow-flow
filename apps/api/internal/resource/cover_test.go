package resource

import (
	"encoding/json"
	"testing"
)

func TestProjectCoverKeepsLatestChangedGeneratedImage(t *testing.T) {
	old := json.RawMessage(`{"nodes":[{"id":"a","type":"textToImage","data":{"imageSrc":"https://oss.test/a.png"}},{"id":"b","type":"imageToImage","data":{"imageSrc":"https://oss.test/b.png"}}]}`)
	now := json.RawMessage(`{"nodes":[{"id":"a","type":"textToImage","data":{"imageSrc":"https://oss.test/new.png"}},{"id":"b","type":"imageToImage","data":{"imageSrc":"https://oss.test/b.png"}}]}`)
	prior := "https://oss.test/b.png"
	cover, err := ProjectCover(now, old, &prior)
	if err != nil || cover == nil || *cover != "https://oss.test/new.png" {
		t.Fatalf("cover=%v err=%v", cover, err)
	}
	cover, err = ProjectCover(now, now, cover)
	if err != nil || cover == nil || *cover != "https://oss.test/new.png" {
		t.Fatalf("stable cover=%v err=%v", cover, err)
	}
}
