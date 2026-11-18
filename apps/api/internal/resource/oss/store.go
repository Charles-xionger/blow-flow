package oss

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"time"

	aliyunoss "github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
)

type Store struct{ Region, Bucket, AccessKeyID, AccessKeySecret string }

func FromEnv() Store {
	return Store{os.Getenv("OSS_REGION"), os.Getenv("OSS_BUCKET_NAME"), os.Getenv("OSS_ACCESS_KEY_ID"), os.Getenv("OSS_ACCESS_KEY_SECRET")}
}

func (s Store) Upload(ctx context.Context, owner, project string, content []byte, contentType string) (string, string, error) {
	if s.Region == "" || s.Bucket == "" || s.AccessKeyID == "" || s.AccessKeySecret == "" {
		return "", "", errors.New("OSS unavailable")
	}
	ext := map[string]string{"image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav"}[contentType]
	if ext == "" || len(content) == 0 || len(content) > 30<<20 {
		return "", "", errors.New("unsupported asset")
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", "", err
	}
	key := "uploads/" + owner + "/" + project + "/" + hex.EncodeToString(random[:]) + "." + ext
	region := strings.TrimPrefix(s.Region, "oss-")
	cfg := aliyunoss.LoadDefaultConfig().WithRegion(region).WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s.AccessKeyID, s.AccessKeySecret))
	client := aliyunoss.NewClient(cfg)
	deadline, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	_, err := client.PutObject(deadline, &aliyunoss.PutObjectRequest{Bucket: aliyunoss.Ptr(s.Bucket), Key: aliyunoss.Ptr(key), Body: bytes.NewReader(content), ContentType: aliyunoss.Ptr(contentType)})
	if err != nil {
		return "", "", err
	}
	return key, "https://" + s.Bucket + "." + s.Region + ".aliyuncs.com/" + key, nil
}

func (s Store) Delete(ctx context.Context, key string) error {
	if s.Region == "" || s.Bucket == "" || s.AccessKeyID == "" || s.AccessKeySecret == "" || !strings.HasPrefix(key, "uploads/") {
		return errors.New("OSS unavailable")
	}
	region := strings.TrimPrefix(s.Region, "oss-")
	cfg := aliyunoss.LoadDefaultConfig().WithRegion(region).WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s.AccessKeyID, s.AccessKeySecret))
	client := aliyunoss.NewClient(cfg)
	deadline, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, err := client.DeleteObject(deadline, &aliyunoss.DeleteObjectRequest{Bucket: aliyunoss.Ptr(s.Bucket), Key: aliyunoss.Ptr(key)})
	return err
}
