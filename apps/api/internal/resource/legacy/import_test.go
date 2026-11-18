package legacy

import (
	"strings"
	"testing"
)

func TestProjectOSSLinksOnlyIndexesTrustedMedia(t *testing.T) {
	link := "https://bucket.oss-cn-hangzhou.aliyuncs.com/images/a.png?token=temporary"
	links := projectOSSLinks(map[string]any{"nodes": []any{map[string]any{"url": link, "preview": link}, map[string]any{"url": "https://other.example/a.png"}, map[string]any{"url": "https://bucket.oss-cn-hangzhou.aliyuncs.com/readme.txt"}}}, "bucket.oss-cn-hangzhou.aliyuncs.com")
	if len(links) != 1 || links[0].Kind != "image" || links[0].ObjectKey != "images/a.png" || strings.Contains(links[0].URL, "token=") {
		t.Fatalf("links=%+v", links)
	}
}
