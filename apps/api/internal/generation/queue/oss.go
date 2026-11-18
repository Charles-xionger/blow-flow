package queue

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	aliyunoss "github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"
	"github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials"
)

var ErrArtifactUnavailable = errors.New("provider temporary file unavailable")

type OSS struct {
	Region, Bucket, AccessKeyID, AccessKeySecret string
	Client                                       *http.Client
}

func OSSFromEnv() OSS {
	return OSS{Region: os.Getenv("OSS_REGION"), Bucket: os.Getenv("OSS_BUCKET_NAME"), AccessKeyID: os.Getenv("OSS_ACCESS_KEY_ID"), AccessKeySecret: os.Getenv("OSS_ACCESS_KEY_SECRET")}
}
func (o OSS) client() *http.Client {
	if o.Client != nil {
		return o.Client
	}
	return &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func (o OSS) objectURL(key string) string {
	return "https://" + o.Bucket + "." + o.Region + ".aliyuncs.com/" + key
}
func (o OSS) sdk() *aliyunoss.Client {
	// Existing web configuration uses an endpoint such as oss-cn-hangzhou;
	// the v2 SDK takes the corresponding signing region cn-hangzhou.
	region := strings.TrimPrefix(o.Region, "oss-")
	cfg := aliyunoss.LoadDefaultConfig().WithRegion(region).WithCredentialsProvider(credentials.NewStaticCredentialsProvider(o.AccessKeyID, o.AccessKeySecret))
	return aliyunoss.NewClient(cfg)
}
func (o OSS) Save(ctx context.Context, source, taskID, fileType string) (string, error) {
	if o.Region == "" || o.Bucket == "" || o.AccessKeyID == "" || o.AccessKeySecret == "" {
		return "", errors.New("OSS unconfigured")
	}
	ext, contentType := "png", "image/png"
	if fileType == "jpg" || fileType == "jpeg" {
		ext, contentType = "jpeg", "image/jpeg"
	}
	key := "images/generation/" + taskID + "/0." + ext
	sdk := o.sdk()
	headCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	_, headErr := sdk.HeadObject(headCtx, &aliyunoss.HeadObjectRequest{Bucket: aliyunoss.Ptr(o.Bucket), Key: aliyunoss.Ptr(key)})
	cancel()
	if headErr == nil {
		return o.objectURL(key), nil
	}
	var serviceErr *aliyunoss.ServiceError
	if !errors.As(headErr, &serviceErr) || serviceErr.StatusCode != 404 {
		return "", headErr
	}
	u, err := url.Parse(source)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return "", errors.New("invalid provider output URL")
	}
	downloadCtx, cancelDownload := context.WithTimeout(ctx, 30*time.Second)
	defer cancelDownload()
	getReq, err := http.NewRequestWithContext(downloadCtx, http.MethodGet, source, nil)
	if err != nil {
		return "", err
	}
	download, err := o.client().Do(getReq)
	if err != nil {
		return "", err
	}
	defer download.Body.Close()
	if download.StatusCode == 403 || download.StatusCode == 404 || download.StatusCode == 410 {
		return "", ErrArtifactUnavailable
	}
	if download.StatusCode != 200 {
		return "", fmt.Errorf("provider file HTTP %d", download.StatusCode)
	}
	const maxImage = 50 << 20
	content, err := io.ReadAll(io.LimitReader(download.Body, maxImage+1))
	if err != nil {
		return "", err
	}
	if len(content) == 0 || len(content) > maxImage {
		return "", errors.New("invalid image size")
	}
	detected := http.DetectContentType(content)
	if detected != contentType {
		return "", errors.New("provider file format mismatch")
	}
	uploadCtx, cancelUpload := context.WithTimeout(ctx, 60*time.Second)
	defer cancelUpload()
	_, err = sdk.PutObject(uploadCtx, &aliyunoss.PutObjectRequest{Bucket: aliyunoss.Ptr(o.Bucket), Key: aliyunoss.Ptr(key), Body: bytes.NewReader(content), ContentType: aliyunoss.Ptr(contentType)})
	if err != nil {
		return "", err
	}
	return o.objectURL(key), nil
}
