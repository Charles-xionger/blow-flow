---
name: Blow Flow 生成运营后台
description: 冷静、精确、可信的内部生成运营界面
colors:
  ink-navy: "oklch(0.208 0.042 265.755)"
  ink-navy-deep: "oklch(0.129 0.042 264.695)"
  cold-white: "oklch(1 0 0)"
  mist-blue-gray: "oklch(0.968 0.007 247.896)"
  muted-blue-gray: "oklch(0.554 0.046 257.417)"
  border-blue-gray: "oklch(0.929 0.013 255.508)"
  focus-blue-gray: "oklch(0.704 0.04 256.788)"
  warning-red: "oklch(0.577 0.245 27.325)"
  brand-night-navy: "#07132f"
  brand-electric-blue: "oklch(0.546 0.245 262.881)"
  brand-cyan: "oklch(0.789 0.154 211.53)"
typography:
  headline:
    fontFamily: "-apple-system, system-ui, Segoe UI, Roboto, Helvetica Neue, Noto Sans, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.333
    letterSpacing: "-0.025em"
  title:
    fontFamily: "-apple-system, system-ui, Segoe UI, Roboto, Helvetica Neue, Noto Sans, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "normal"
  body:
    fontFamily: "-apple-system, system-ui, Segoe UI, Roboto, Helvetica Neue, Noto Sans, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.429
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, system-ui, Segoe UI, Roboto, Helvetica Neue, Noto Sans, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.333
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink-navy}"
    textColor: "{colors.cold-white}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.cold-white}"
    textColor: "{colors.ink-navy-deep}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-navy-deep}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "36px"
  card:
    backgroundColor: "{colors.cold-white}"
    textColor: "{colors.ink-navy-deep}"
    rounded: "{rounded.xl}"
    padding: "24px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink-navy-deep}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  badge-normal:
    backgroundColor: "{colors.mist-blue-gray}"
    textColor: "{colors.ink-navy}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-destructive:
    backgroundColor: "{colors.warning-red}"
    textColor: "{colors.cold-white}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  nav-item-active:
    backgroundColor: "{colors.mist-blue-gray}"
    textColor: "{colors.ink-navy}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "36px"
---

# Design System: Blow Flow 生成运营后台

## Overview

**Creative North Star: "精密运营台"**

这套界面像一张经过校准的运营工作台：信息密度高，但每个状态、口径和操作都能快速扫描。冷白表面、墨蓝黑文字和雾蓝灰层级让真实数据先于装饰出现，视觉表达冷静、精确、可信。

界面以克制而精确的组件支撑高频运营任务。品牌蓝与青色只在登录品牌区和品牌图像中形成识别，进入操作界面后主动退场；描边承担主要结构，低环境阴影只帮助识别可操作容器。避免消费级游戏化、霓虹渐变和装饰性数据图表。

**Key Characteristics:**

- 冷白工作面与墨蓝黑信息层级
- 紧凑、可扫描的运营密度
- 轻描边优先，低环境阴影辅助
- 状态颜色只表达真实语义
- 品牌表现集中在入口，操作界面保持安静

## Colors

配色以冷白、墨蓝黑和雾蓝灰构成运营界面的主体，警戒红只用于破坏性或错误状态；品牌电蓝和青色集中用于登录入口与品牌标识。

### Primary

- **墨蓝黑**（`ink-navy`）：主要按钮、活跃导航和高强调文字；用低明度建立权威感，而不是依赖高饱和强调。
- **深墨蓝黑**（`ink-navy-deep`）：正文、标题与关键数据的默认前景色。

### Secondary

- **品牌电蓝**（`brand-electric-blue`）：登录品牌区的光晕与品牌图像呼应，不作为运营状态色。

### Tertiary

- **品牌青**（`brand-cyan`）：入口品牌区的辅助光色和小范围标签强调。

### Neutral

- **冷白**（`cold-white`）：页面、卡片与输入表面的默认底色。
- **雾蓝灰**（`mist-blue-gray`）：活跃导航、次级按钮和弱状态底色。
- **中性蓝灰**（`muted-blue-gray`）：辅助说明、时间和低优先级元数据。
- **边界蓝灰**（`border-blue-gray`）：卡片、表格、输入框与结构分隔线。
- **焦点蓝灰**（`focus-blue-gray`）：键盘焦点环和可访问性状态。
- **品牌夜蓝**（`brand-night-navy`）：仅用于登录入口的大面积品牌背景。
- **警戒红**（`warning-red`）：错误、禁用和破坏性操作；不用于普通提醒。

**The Quiet Signal Rule.** 操作界面以中性色为常态；高彩度颜色必须对应品牌入口或明确的风险语义，不能仅为“让页面更活泼”而出现。

## Typography

**Display Font:** 系统无衬线字体栈
**Body Font:** 系统无衬线字体栈

**Character:** 同一套系统字体贯穿标题、数据和操作标签，以字重、字号和空间而非字体混搭建立层级。中文与英文数字保持原生清晰度，适合长时间扫描运营数据。

### Hierarchy

- **Headline**（700，24px，32px 行高）：页面主标题，使用轻微负字距压紧轮廓。
- **Title**（600，16px，20px 行高）：卡片标题、对话框标题和模块级标题。
- **Body**（400，14px，20px 行高）：表格、说明、按钮和大多数操作内容。
- **Label**（500，12px，16px 行高）：导航分组、状态标签和低层级元数据。

登录品牌区允许使用 36–48px 的高识别标题，但这一尺度不进入日常运营页面。

**The Scan Before Style Rule.** 运营页面先保证一眼区分标题、数值、状态和动作；不通过全大写、装饰字体或夸张字号制造层级。

## Layout

后台采用固定侧栏、顶部工具栏和居中内容区的应用壳。展开侧栏宽 256px，桌面可收至 64px；主内容最大宽度 1280px，页面内边距在小屏为 16px、较宽屏为 24px。主节奏以 4px 为基准，8px、12px、16px 和 24px 组成常用间距。

总览卡片从两列过渡到四列，明细区域在大屏使用双列。数据表保持横向滚动而不压缩字段。小于 768px 时侧栏转为带遮罩的抽屉，顶部保留打开导航的入口；表单字号至少 16px，避免移动浏览器自动缩放。

登录页在大屏使用品牌叙事区与认证表单并列，小屏隐藏品牌叙事区，让认证任务占据完整宽度。登录表单的最大宽度为 448px。

## Elevation & Depth

系统采用轻度分层：结构主要由冷白表面、边界蓝灰描边和相邻底色差建立。卡片使用低环境阴影（`0 1px 3px rgb(0 0 0 / 0.10), 0 1px 2px -1px rgb(0 0 0 / 0.10)`），常规按钮仅保留极浅阴影（`0 1px 2px rgb(0 0 0 / 0.05)`）。登录品牌区的光晕属于入口识别，不应扩散到运营内容区。

### Shadow Vocabulary

- **低环境卡片阴影**：帮助卡片从同色背景上被识别，不表达悬浮操作。
- **微型控件阴影**：用于有实体表面的按钮与输入框，保持几乎不可察觉。
- **登录品牌光晕**：仅服务入口品牌叙事和标志，不作为通用组件阴影。

**The Border Before Shadow Rule.** 默认先使用描边和底色建立分区；只有描边不足以表达容器或浮层时才增加阴影。

## Shapes

形状以温和但不柔软的圆角矩形为主。按钮、输入、导航项和状态标签使用 8px 圆角；基础面板使用 10px；主要卡片使用 14px。描边通常为 1px。圆形仅用于品牌入口的展示构图和纯图标容器，不用于常规数据卡片。

对话框延续 12–14px 的容器圆角，并通过深色半透明遮罩与页面分离。表格行保持平直，不把每一行包装成独立圆角卡片。

## Components

组件整体克制而精确：尺寸紧凑、状态清楚、反馈直接，并为键盘焦点保留明确的三像素半透明焦点环。

### Buttons

- **Shape:** 8px 圆角，常规高度 36px；小号 32px，大号 40px。
- **Primary:** 墨蓝黑底、冷白文字，常规水平内边距 16px。
- **Hover / Focus:** 悬停仅降低少量不透明度；键盘焦点使用焦点蓝灰环，不以位移或弹跳吸引注意。
- **Outline:** 冷白底、边界蓝灰描边，悬停转为雾蓝灰表面。
- **Ghost:** 默认透明，只在悬停时出现雾蓝灰表面。
- **Destructive:** 警戒红只用于确实会改变账户或数据状态的动作。

### Chips

- **Style:** 状态徽标使用 8px 圆角、12px 中等字重和紧凑的 2px × 8px 内边距。
- **State:** 正常状态使用雾蓝灰与墨蓝黑；禁用或错误状态使用警戒红与冷白。

### Cards / Containers

- **Corner Style:** 14px 圆角。
- **Background:** 冷白表面与深墨蓝黑文字。
- **Shadow Strategy:** 使用低环境卡片阴影，不制造浮动仪表盘效果。
- **Border:** 1px 边界蓝灰。
- **Internal Padding:** 主要内容使用 24px；标题与正文通过 6–24px 间距形成组块。

### Inputs / Fields

- **Style:** 36px 高、8px 圆角、1px 边界蓝灰描边；登录表单可提升到 44px。
- **Focus:** 边界转为焦点蓝灰，并出现 3px 半透明焦点环。
- **Error / Disabled:** 错误使用警戒红边界与低透明度焦点环；禁用降低至 50% 不透明度并取消交互。

### Navigation

侧栏以 14px 标签和 16px 线性图标组成 36px 高的导航项。默认状态不使用底色；悬停和活跃状态使用雾蓝灰，活跃项提升至中等字重。分组标题使用 12px 中等字重和弱前景色。桌面侧栏可折叠，移动端作为带遮罩抽屉出现。

### Tables

表格使用 14px 正文、40px 表头和 8px 单元格内边距。行之间以细描边分隔，悬停只增加半透明雾蓝灰底色。字段保持单行并允许容器横向滚动，以保护运营字段的可读性。

### Alerts and Dialogs

页面级提示使用带描边的低饱和语义底色；错误信息使用警戒红但不扩大视觉面积。禁用用户对话框采用原生模态语义、集中说明影响、要求填写原因，并将破坏性动作放在确认区末端。

## Do's and Don'ts

### Do:

- **Do** 让真实状态、时间、成本口径和可执行动作形成清楚的扫描顺序。
- **Do** 优先使用 8px、12px、16px 和 24px 的既有间距节奏。
- **Do** 使用描边和底色建立结构，仅在容器确实需要分层时使用低环境阴影。
- **Do** 为键盘操作保留清晰焦点环，并让移动端表单字号不低于 16px。
- **Do** 将品牌电蓝和品牌青集中用于入口品牌区与品牌标识。

### Don't:

- **Don't** 使用消费级游戏化、积分感徽章或庆祝式动效包装运营数据。
- **Don't** 使用霓虹渐变、高饱和大面积背景或装饰性数据图表替代真实信息层级。
- **Don't** 为每一行数据增加独立圆角卡片和阴影，破坏表格的连续扫描。
- **Don't** 用颜色暗示未经权威接口确认的成功、成本或系统健康状态。
- **Don't** 把登录入口的品牌光晕和大型标题复制到日常运营页面。
