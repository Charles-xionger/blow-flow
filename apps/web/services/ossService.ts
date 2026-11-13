import OSS from "ali-oss";
import { nanoid } from "nanoid";

// 单例实例
let ossClientInstance: OSSClient | null = null;

export class OSSClient {
  private client: OSS;
  private bucketDomain: string;

  constructor() {
    // 验证环境变量
    if (
      !process.env.OSS_REGION ||
      !process.env.OSS_ACCESS_KEY_ID ||
      !process.env.OSS_ACCESS_KEY_SECRET ||
      !process.env.OSS_BUCKET_NAME
    ) {
      throw new Error("OSS 环境变量未配置完整，请检查 .env.local 文件");
    }

    this.client = new OSS({
      region: process.env.OSS_REGION,
      accessKeyId: process.env.OSS_ACCESS_KEY_ID,
      accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
      bucket: process.env.OSS_BUCKET_NAME,
    });

    // 构建 Bucket 域名
    const region = process.env.OSS_REGION;
    const bucket = process.env.OSS_BUCKET_NAME;
    this.bucketDomain = `https://${bucket}.${region}.aliyuncs.com`;
  }

  /**
   * 获取单例实例
   */
  static getInstance(): OSSClient {
    if (!ossClientInstance) {
      ossClientInstance = new OSSClient();
    }
    return ossClientInstance;
  }

  /**
   * 生成唯一的文件路径
   * @param folder 文件夹名称（如 'images', 'videos'）
   * @param filename 原始文件名
   */
  generateObjectKey(folder: string, filename: string): string {
    const timestamp = Date.now();
    const randomId = nanoid(8);
    const ext = filename.split(".").pop();
    return `${folder}/${timestamp}-${randomId}.${ext}`;
  }

  /**
   * 从完整 URL 中提取 Object Key
   * @param url OSS 完整 URL
   */
  extractObjectKeyFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      // 去掉开头的 /
      return urlObj.pathname.substring(1);
    } catch {
      return null;
    }
  }

  /**
   * 获取文件的公网访问 URL
   * @param objectKey OSS 中的文件路径
   */
  getPublicUrl(objectKey: string): string {
    return `${this.bucketDomain}/${objectKey}`;
  }

  /**
   * 上传文件到 OSS
   * @param objectKey OSS 中的文件路径（不包含 Bucket 名称）
   * @param content 文件内容，可以是 Buffer、string 或本地文件路径
   * @param headers 自定义请求头
   */
  async uploadObject(
    objectKey: string,
    content: Buffer | string,
    headers?: Record<string, any>,
  ) {
    try {
      const result = await this.client.put(objectKey, content, { headers });
      console.log(`[OSS] 上传成功: ${objectKey}`);
      return {
        ...result,
        url: this.getPublicUrl(objectKey),
      };
    } catch (error) {
      console.error("[OSS] 上传对象失败:", error);
      throw error;
    }
  }

  /**
   * 从 URL 下载文件并上传到 OSS
   * @param url 源文件 URL（支持 http/https URL 和 base64 data URL）
   * @param folder 目标文件夹（如 'images', 'videos'）
   * @param filename 文件名（可选，默认从 URL 提取）
   */
  async downloadAndUpload(
    url: string,
    folder: string,
    filename?: string,
  ): Promise<{ objectKey: string; url: string; size: number }> {
    try {
      console.log(`[OSS] 开始处理 URL: ${url.substring(0, 100)}...`);

      let buffer: Buffer;

      // 检查是否是 base64 data URL
      if (url.startsWith("data:")) {
        console.log("[OSS] 检测到 base64 数据，直接转换");

        // 提取 base64 数据
        const matches = url.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches) {
          throw new Error("无效的 base64 data URL 格式");
        }

        const mimeType = matches[1];
        const base64Data = matches[2];

        // 如果没有提供文件名，根据 MIME 类型生成
        if (!filename) {
          const ext = mimeType.split("/")[1] || "png";
          filename = `file-${Date.now()}.${ext}`;
        }

        // 转换为 Buffer
        buffer = Buffer.from(base64Data, "base64");
        console.log(`[OSS] Base64 转换成功，大小: ${buffer.length} 字节`);
      } else {
        // HTTP/HTTPS URL，下载文件
        console.log(`[OSS] 开始从 HTTP(S) URL 下载`);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`下载失败: ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
        console.log(`[OSS] 下载成功，大小: ${buffer.length} 字节`);

        // 生成文件名
        if (!filename) {
          const urlPath = new URL(url).pathname;
          filename = urlPath.split("/").pop() || `file-${Date.now()}.bin`;
        }
      }

      // 生成 OSS 路径
      const objectKey = this.generateObjectKey(folder, filename);

      // 上传到 OSS，设置正确的 Content-Type
      const contentType = filename.endsWith(".png")
        ? "image/png"
        : filename.endsWith(".jpg") || filename.endsWith(".jpeg")
          ? "image/jpeg"
          : filename.endsWith(".webp")
            ? "image/webp"
            : "application/octet-stream";

      await this.uploadObject(objectKey, buffer, {
        "Content-Type": contentType,
      });

      console.log(`[OSS] 上传成功: ${objectKey}, Content-Type: ${contentType}`);

      return {
        objectKey,
        url: this.getPublicUrl(objectKey),
        size: buffer.length,
      };
    } catch (error) {
      console.error("[OSS] 下载并上传失败:", error);
      throw error;
    }
  }

  /**
   * 直接上传 Buffer 到 OSS
   * @param buffer 文件内容 Buffer
   * @param folder 目标文件夹（如 'images', 'videos'）
   * @param filename 文件名
   */
  async uploadBuffer(
    buffer: Buffer,
    folder: string,
    filename: string,
  ): Promise<{ objectKey: string; url: string; size: number }> {
    try {
      console.log(`[OSS] 开始上传 Buffer，大小: ${buffer.length} 字节`);

      // 生成 OSS 路径
      const objectKey = this.generateObjectKey(folder, filename);

      // 上传到 OSS
      await this.uploadObject(objectKey, buffer);

      console.log(`[OSS] 上传成功: ${objectKey}`);

      return {
        objectKey,
        url: this.getPublicUrl(objectKey),
        size: buffer.length,
      };
    } catch (error) {
      console.error("[OSS] 上传 Buffer 失败:", error);
      throw error;
    }
  }

  /**
   * 下载文件从 OSS
   * @param objectKey OSS 中的文件路径
   * @param localPath 本地保存路径（可选）
   */
  async downloadObject(objectKey: string, localPath?: string) {
    try {
      const result = await this.client.get(objectKey, localPath);
      console.log(`[OSS] 下载成功: ${objectKey}`);
      return result;
    } catch (error) {
      console.error("[OSS] 下载对象失败:", error);
      throw error;
    }
  }

  /**
   * 获取文件内容（返回 Buffer）
   * @param objectKey OSS 中的文件路径
   */
  async getObjectContent(objectKey: string): Promise<Buffer> {
    try {
      const result = await this.client.get(objectKey);
      return result.content as Buffer;
    } catch (error) {
      console.error("[OSS] 获取对象内容失败:", error);
      throw error;
    }
  }

  /**
   * 删除文件
   * @param objectKeyOrUrl OSS 中的文件路径或完整 URL
   */
  async deleteObject(objectKeyOrUrl: string) {
    try {
      // 如果是完整 URL，提取 objectKey
      let objectKey = objectKeyOrUrl;
      if (objectKeyOrUrl.startsWith("http")) {
        const extracted = this.extractObjectKeyFromUrl(objectKeyOrUrl);
        if (!extracted) {
          throw new Error("无法从 URL 中提取 objectKey");
        }
        objectKey = extracted;
      }

      const result = await this.client.delete(objectKey);
      console.log(`[OSS] 删除成功: ${objectKey}`);
      return result;
    } catch (error) {
      console.error("[OSS] 删除对象失败:", error);
      throw error;
    }
  }

  /**
   * 批量删除文件
   * @param objectKeys OSS 中的文件路径数组
   */
  async deleteMultipleObjects(objectKeys: string[]) {
    try {
      const result = await this.client.deleteMulti(objectKeys, { quiet: true });
      console.log(`[OSS] 批量删除成功: ${objectKeys.length} 个文件`);
      return result;
    } catch (error) {
      console.error("[OSS] 批量删除对象失败:", error);
      throw error;
    }
  }

  /**
   * 列出文件列表
   * @param prefix 文件前缀（可选）
   * @param maxKeys 最大返回数量，默认 100
   */
  async listObjects(
    prefix?: string,
    maxKeys: number = 100,
  ): Promise<OSS.ListObjectResult> {
    try {
      const query: any = {};
      if (prefix) query.prefix = prefix;
      if (maxKeys) query["max-keys"] = maxKeys;

      const result = await this.client.list(query, {});
      console.log(
        `[OSS] 列出文件成功: 共 ${result.objects?.length || 0} 个文件`,
      );
      return result;
    } catch (error) {
      console.error("[OSS] 列出对象失败:", error);
      throw error;
    }
  }

  /**
   * 检查文件是否存在
   * @param objectKey OSS 中的文件路径
   */
  async objectExists(objectKey: string): Promise<boolean> {
    try {
      await this.client.head(objectKey);
      return true;
    } catch (error: any) {
      if (error.code === "NoSuchKey") {
        return false;
      }
      throw error;
    }
  }

  /**
   * 获取文件元信息
   * @param objectKey OSS 中的文件路径
   */
  async getObjectMeta(objectKey: string) {
    try {
      const result = await this.client.head(objectKey);
      return result;
    } catch (error) {
      console.error("[OSS] 获取对象元信息失败:", error);
      throw error;
    }
  }

  /**
   * 生成签名 URL（用于临时访问私有文件）
   * @param objectKey OSS 中的文件路径
   * @param expires 过期时间（秒），默认 3600 秒（1小时）
   */
  async generateSignedUrl(
    objectKey: string,
    expires: number = 3600,
  ): Promise<string> {
    try {
      const url = this.client.signatureUrl(objectKey, { expires });
      console.log(`[OSS] 生成签名 URL: ${objectKey}`);
      return url;
    } catch (error) {
      console.error("[OSS] 生成签名 URL 失败:", error);
      throw error;
    }
  }

  /**
   * 复制文件
   * @param sourceKey 源文件路径
   * @param targetKey 目标文件路径
   */
  async copyObject(sourceKey: string, targetKey: string) {
    try {
      const result = await this.client.copy(targetKey, sourceKey);
      console.log(`[OSS] 复制成功: ${sourceKey} -> ${targetKey}`);
      return result;
    } catch (error) {
      console.error("[OSS] 复制对象失败:", error);
      throw error;
    }
  }
}

// 导出单例获取函数
export const getOSSClient = () => OSSClient.getInstance();
