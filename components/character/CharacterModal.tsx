"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Upload, Trash2, Loader2, Sparkles } from "lucide-react";
import type { Character } from "@/types";
import { toast } from "sonner";

interface CharacterModalProps {
  character: Character | null;
  onClose: (saved: boolean) => void;
  prefilledImage?: string;
  analyzedData?: {
    name: string;
    description: string;
    tags: string[];
    appearance?: {
      age?: string;
      gender?: string;
      hair?: string;
      clothing?: string;
    };
  };
}

export function CharacterModal({
  character,
  onClose,
  prefilledImage,
  analyzedData,
}: CharacterModalProps) {
  const isEdit = !!character;
  const isAIGenerated = !!analyzedData;

  const [name, setName] = useState(character?.name || "");
  const [description, setDescription] = useState(character?.description || "");
  const [tags, setTags] = useState<string[]>(character?.tags || []);
  const [tagInput, setTagInput] = useState("");
  const [referenceImages, setReferenceImages] = useState<string[]>(
    character?.referenceImages || [],
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // Auto-fill form with AI-analyzed data
  useEffect(() => {
    if (analyzedData && !character) {
      setName(analyzedData.name || "");
      setDescription(analyzedData.description || "");
      setTags(analyzedData.tags || []);
    }
    if (prefilledImage && !character) {
      setReferenceImages([prefilledImage]);
    }
  }, [analyzedData, prefilledImage, character]);

  // 处理图片上传
  const handleImageUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    // 检查数量限制
    if (referenceImages.length + files.length > 5) {
      toast.error("最多只能上传5张参考图");
      return;
    }

    setIsUploading(true);

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // 验证文件类型
        if (!file.type.startsWith("image/")) {
          toast.error(`${file.name} 不是有效的图片文件`);
          continue;
        }

        // 验证文件大小（最大10MB）
        if (file.size > 10 * 1024 * 1024) {
          toast.error(`${file.name} 文件过大，最大支持10MB`);
          continue;
        }

        // 转换为base64并上传
        const formData = new FormData();
        formData.append("image", file);

        const response = await fetch("/api/upload/image", {
          method: "POST",
          body: formData,
        });

        const result = await response.json();

        if (result.success && result.url) {
          setReferenceImages((prev) => [...prev, result.url]);
        } else {
          toast.error(`上传 ${file.name} 失败: ${result.error}`);
        }
      }
    } catch (error) {
      console.error("Upload error:", error);
      toast.error("图片上传失败");
    } finally {
      setIsUploading(false);
    }
  };

  // 删除图片
  const handleRemoveImage = (index: number) => {
    setReferenceImages((prev) => prev.filter((_, i) => i !== index));
  };

  // 添加标签
  const handleAddTag = () => {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags((prev) => [...prev, trimmed]);
      setTagInput("");
    }
  };

  // 删除标签
  const handleRemoveTag = (index: number) => {
    setTags((prev) => prev.filter((_, i) => i !== index));
  };

  // 提交表单
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // 验证
    if (!name.trim()) {
      toast.error("请输入角色名称");
      return;
    }

    if (!description.trim()) {
      toast.error("请输入角色描述");
      return;
    }

    if (referenceImages.length === 0) {
      toast.error("请至少上传一张参考图");
      return;
    }

    setIsSubmitting(true);

    try {
      const url = isEdit ? `/api/character/${character.id}` : "/api/character";

      const method = isEdit ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          referenceImages,
          tags,
        }),
      });

      const result = await response.json();

      if (result.success) {
        console.log(
          "[CharacterModal] Character saved successfully:",
          result.data,
        );
        toast.success(isEdit ? "角色已更新" : "角色已创建");
        onClose(true);
      } else {
        toast.error(result.error || "操作失败");
      }
    } catch (error) {
      console.error("Submit error:", error);
      toast.error("操作失败");
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[10000] p-4"
      onClick={() => !isSubmitting && onClose(false)}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="bg-zinc-900 rounded-xl border border-zinc-800 w-[90vw] max-w-4xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between p-6 border-b border-zinc-800">
          <h2 className="text-xl font-semibold text-white">
            {isEdit ? "编辑角色" : "创建新角色"}
          </h2>
          <button
            onClick={() => !isSubmitting && onClose(false)}
            className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
            disabled={isSubmitting}
          >
            <X className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        {/* 表单内容 */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6">
          <div className="space-y-6">
            {/* 角色名称 */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                角色名称 <span className="text-red-400">*</span>
                {isAIGenerated && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-purple-400">
                    <Sparkles className="w-3 h-3" />
                    AI 生成
                  </span>
                )}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：女主角、男配角、旁白者..."
                className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                maxLength={50}
                required
              />
            </div>

            {/* 角色描述 */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                角色描述 <span className="text-red-400">*</span>
                {isAIGenerated && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-purple-400">
                    <Sparkles className="w-3 h-3" />
                    AI 生成
                  </span>
                )}
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="详细描述角色的外貌、性格、服装等特征，这将帮助AI生成一致的角色形象..."
                className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50 min-h-[120px] resize-y"
                required
              />
              {isAIGenerated && analyzedData?.appearance && (
                <div className="mt-2 p-3 bg-purple-500/10 border border-purple-500/20 rounded-lg">
                  <p className="text-xs font-medium text-purple-400 mb-1">
                    AI 识别的外貌特征：
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-xs text-gray-300">
                    {analyzedData.appearance.age && (
                      <div>
                        <span className="text-gray-500">年龄：</span>
                        {analyzedData.appearance.age}
                      </div>
                    )}
                    {analyzedData.appearance.gender && (
                      <div>
                        <span className="text-gray-500">性别：</span>
                        {analyzedData.appearance.gender}
                      </div>
                    )}
                    {analyzedData.appearance.hair && (
                      <div>
                        <span className="text-gray-500">发型：</span>
                        {analyzedData.appearance.hair}
                      </div>
                    )}
                    {analyzedData.appearance.clothing && (
                      <div>
                        <span className="text-gray-500">服装：</span>
                        {analyzedData.appearance.clothing}
                      </div>
                    )}
                  </div>
                </div>
              )}
              <p className="text-xs text-gray-500 mt-1">
                提示：描述越详细，生成的角色越一致
              </p>
            </div>

            {/* 参考图片 */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                参考图片 <span className="text-red-400">*</span>{" "}
                <span className="text-xs text-gray-500">(1-5张)</span>
              </label>

              <div className="grid grid-cols-3 gap-3 mb-3">
                {referenceImages.map((url, index) => (
                  <div
                    key={index}
                    className="relative aspect-square bg-zinc-800 rounded-lg overflow-hidden group"
                  >
                    <img
                      src={url}
                      alt={`参考图 ${index + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveImage(index)}
                      className="absolute top-1 right-1 p-1.5 bg-red-500/90 hover:bg-red-600 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 className="w-4 h-4 text-white" />
                    </button>
                  </div>
                ))}

                {/* 上传按钮 */}
                {referenceImages.length < 5 && (
                  <label className="aspect-square bg-zinc-800 hover:bg-zinc-700 border-2 border-dashed border-zinc-700 hover:border-purple-500 rounded-lg flex flex-col items-center justify-center cursor-pointer transition-all">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleImageUpload}
                      className="hidden"
                      disabled={isUploading}
                    />
                    {isUploading ? (
                      <Loader2 className="w-8 h-8 text-purple-500 animate-spin" />
                    ) : (
                      <>
                        <Upload className="w-8 h-8 text-gray-500 mb-1" />
                        <span className="text-xs text-gray-500">上传图片</span>
                      </>
                    )}
                  </label>
                )}
              </div>

              <p className="text-xs text-gray-500">
                支持 JPG、PNG、WEBP 格式，最大10MB
              </p>
            </div>

            {/* 标签 */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                标签
                {isAIGenerated && tags.length > 0 && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-purple-400">
                    <Sparkles className="w-3 h-3" />
                    AI 生成
                  </span>
                )}
              </label>

              <div className="flex gap-2 mb-2">
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                  placeholder="输入标签后按回车添加..."
                  className="flex-1 px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                />
                <button
                  type="button"
                  onClick={handleAddTag}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors"
                >
                  添加
                </button>
              </div>

              {tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {tags.map((tag, index) => (
                    <span
                      key={index}
                      className="inline-flex items-center gap-1 px-3 py-1 bg-purple-500/20 text-purple-300 rounded-full text-sm"
                    >
                      {tag}
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(index)}
                        className="hover:text-purple-100"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <p className="text-xs text-gray-500 mt-2">
                例如：女性、20岁、现代、商务、黑发等
              </p>
            </div>
          </div>
        </form>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-zinc-800">
          <button
            type="button"
            onClick={() => onClose(false)}
            disabled={isSubmitting}
            className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || isUploading}
            className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {isEdit ? "保存" : "创建"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
