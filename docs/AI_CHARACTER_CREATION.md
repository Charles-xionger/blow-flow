# AI-Powered Character Creation Workflow

## Overview

This document describes the intelligent character creation workflow that allows users to generate images and automatically extract structured character data using AI vision analysis.

## Workflow Steps

### 1. Generate Image

User creates an image using TextToImageNode with a prompt describing the character.

### 2. Right-Click Menu

After the image is generated, user can right-click on the image and select "保存为角色" (Save as Character).

### 3. AI Analysis

- System calls `/api/character/analyze-image` with the image URL and original prompt
- Gemini 2.0 Flash Exp Vision API analyzes the image
- Extracts structured data:
  - `character_name`: AI-generated character name
  - `detailed_description`: Complete character description
  - `appearance`: Physical attributes (age, gender, hair, clothing)
  - `tags`: Relevant character tags

### 4. Pre-filled Modal

CharacterModal opens with AI-analyzed data pre-filled:

- Name field shows AI-generated name with 💫 "AI 生成" badge
- Description field shows detailed description with 💫 badge
- Appearance details displayed in purple info box
- Tags array automatically populated with 💫 badge
- Generated image automatically added to reference images

### 5. User Review & Save

- User can edit any AI-generated field
- User can add more reference images (up to 5 total)
- User can add/remove tags
- Click "创建" to save character to database

## Technical Implementation

### API Endpoint

```
POST /api/character/analyze-image
Body: { imageUrl: string, prompt: string }
Response: { success: boolean, data: AnalyzedCharacterData }
```

### Event Communication

```typescript
// TextToImageNode dispatches event
window.dispatchEvent(new CustomEvent("openCharacterModal", {
  detail: {
    prefilledImage: imageUrl,
    prefilledPrompt: prompt,
    analyzedData: {
      name: string,
      description: string,
      tags: string[],
      appearance: {
        age?: string,
        gender?: string,
        hair?: string,
        clothing?: string
      }
    }
  }
}));

// CharacterLibrary listens for event
useEffect(() => {
  const handleOpenModal = (event: Event) => {
    const customEvent = event as CustomEvent;
    const { prefilledImage, analyzedData } = customEvent.detail;
    setPrefilledData({ image: prefilledImage, analyzedData });
    setShowModal(true);
  };

  window.addEventListener("openCharacterModal", handleOpenModal);
  return () => window.removeEventListener("openCharacterModal", handleOpenModal);
}, []);
```

### CharacterModal Props

```typescript
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
```

## AI Model Details

### Gemini 2.0 Flash Exp

- **Purpose**: Vision-based image understanding and structured data extraction
- **Input**: Image (base64) + Text prompt describing the character
- **Output**: JSON with character attributes
- **Prompt Strategy**:
  - Instructs model to analyze visual appearance
  - Requests specific JSON structure
  - Combines image pixels with text context for better accuracy

### Prompt Template

```
请分析这张图片中的角色特征，并提取以下信息：

1. character_name: 为角色起一个合适的中文名字
2. detailed_description: 详细描述角色的外貌、服装、风格等特征
3. appearance: 包含以下字段
   - age: 年龄段（如"25-30岁"）
   - gender: 性别
   - hair: 发型和发色
   - clothing: 服装风格
4. tags: 3-5个描述性标签（如"女性"、"职业装"、"现代"）

原始提示词：{prompt}

请以JSON格式返回结果。
```

## UI Features

### Visual Indicators

- **Sparkles Icon (✨)**: Shows next to AI-generated field labels
- **"AI 生成" Badge**: Purple badge indicating AI-generated content
- **Appearance Info Box**: Purple-bordered box showing extracted physical attributes
- **Editable Fields**: All AI-generated values can be manually edited

### User Experience

1. **Loading State**: Toast notification "正在分析图片..." during API call
2. **Success State**: Modal opens with pre-filled data
3. **Error Fallback**: If AI analysis fails, modal opens empty for manual entry
4. **Manual Override**: User can edit any AI-generated value before saving

## Database Schema

Character data is stored in SQLite with the following structure:

```sql
CREATE TABLE characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  referenceImages TEXT NOT NULL,  -- JSON array of image URLs
  tags TEXT,                       -- JSON array of tags
  loraModelUrl TEXT,
  loraWeight REAL DEFAULT 0.8,
  loraStatus TEXT DEFAULT 'none',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
```

## Future Enhancements

### Planned Features

1. **Character Consistency Methods**:
   - Add `consistencyMethod` field: 'wanx-faceid' | 'banana-multi' | 'none'
   - Add `primaryImageIndex` to select main reference face
2. **Image Generation Integration**:
   - Modify TextToImageNode to support character injection
   - Pass `ref_img` parameter to 通义万相 API
   - Pass multiple images to BananaPro API
   - Set `ref_strength` parameter (default: 0.85)

3. **LoRA Training** (Future):
   - Automatic LoRA model training from reference images
   - LoRA model management and versioning
   - Real-time training status updates

## Testing Checklist

- [x] Image analysis API returns structured data
- [x] Right-click menu appears on generated images
- [x] Loading toast shows during analysis
- [x] Modal opens with pre-filled data
- [x] AI badges display correctly
- [x] Appearance info box shows all extracted fields
- [x] User can edit AI-generated values
- [x] Character saves to database successfully
- [ ] Test with various image styles (realistic, anime, cartoon)
- [ ] Test with different character types (male, female, non-human)
- [ ] Test error handling (network failure, invalid image)
- [ ] Test with non-character images (should still work)

## API Keys Required

- `GEMINI_API_KEY`: Google Gemini API key for vision analysis
- OSS credentials: For image storage and retrieval

## Error Handling

### Common Scenarios

1. **Network Error**: Shows toast "图片分析失败，请手动输入"
2. **Invalid Image**: Analysis may return generic data, user can edit
3. **API Rate Limit**: Graceful fallback to manual entry
4. **JSON Parse Error**: System extracts JSON from markdown code blocks

### Fallback Strategy

If AI analysis fails at any step, the system opens an empty CharacterModal, allowing users to manually enter character details and upload images as usual.

## Performance Considerations

- Image download timeout: 30 seconds
- AI analysis timeout: 30 seconds
- Image size limit: 10MB per image
- Maximum reference images: 5 per character
- Base64 encoding happens server-side to avoid client payload size

## Security Notes

- Image URLs must be from trusted OSS domains
- API endpoint validates image format and size
- User input is sanitized before database insertion
- API keys stored securely in environment variables
