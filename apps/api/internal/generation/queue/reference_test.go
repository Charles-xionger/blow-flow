package queue

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestInspectReferenceDetectsTransparency(t *testing.T) {
	for _, tc := range []struct {
		name  string
		alpha uint8
		want  bool
	}{{"opaque", 255, false}, {"transparent", 0, true}} {
		t.Run(tc.name, func(t *testing.T) {
			img := image.NewNRGBA(image.Rect(0, 0, 16, 16))
			for y := 0; y < 16; y++ {
				for x := 0; x < 16; x++ {
					img.SetNRGBA(x, y, color.NRGBA{R: 255, A: tc.alpha})
				}
			}
			var body bytes.Buffer
			if err := png.Encode(&body, img); err != nil {
				t.Fatal(err)
			}
			info, err := inspectReference(context.Background(), body.Bytes(), "reference.png", "image")
			if err != nil || info.HasAlpha != tc.want {
				t.Fatalf("info=%#v err=%v", info, err)
			}
		})
	}
}
