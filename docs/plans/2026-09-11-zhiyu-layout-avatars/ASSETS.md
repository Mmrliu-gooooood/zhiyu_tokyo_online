# Zhiyu 最终卡通头像素材

状态：7 张源图已生成并复制到本方案目录，尚未接入应用。

采用内置 image_gen 工具生成，未使用 CLI/API fallback。六位 AI 角色与默认用户均为新设计的二维 Q 版卡通。之前偏写实的草稿已排除在交付目录与实施方案之外。

返回[行动方案](D:/ZZGG_Innovation_Project/OpenMAIC-main/docs/plans/2026-09-11-zhiyu-layout-avatars/README.md)。

## 文件清单

| 人物 | 源图 | 实测尺寸 | 格式 |
| --- | --- | --- | --- |
| 启衡 | [qiheng.png](D:/ZZGG_Innovation_Project/OpenMAIC-main/docs/plans/2026-09-11-zhiyu-layout-avatars/assets/qiheng.png) | 1254×1254 | PNG，透明背景 |
| 知微 | [zhiwei.png](D:/ZZGG_Innovation_Project/OpenMAIC-main/docs/plans/2026-09-11-zhiyu-layout-avatars/assets/zhiwei.png) | 1254×1254 | PNG，透明背景 |
| 悦扬 | [yueyang.png](D:/ZZGG_Innovation_Project/OpenMAIC-main/docs/plans/2026-09-11-zhiyu-layout-avatars/assets/yueyang.png) | 1254×1254 | PNG，透明背景 |
| 问熙 | [wenxi.png](D:/ZZGG_Innovation_Project/OpenMAIC-main/docs/plans/2026-09-11-zhiyu-layout-avatars/assets/wenxi.png) | 1254×1254 | PNG，透明背景 |
| 书言 | [shuyan.png](D:/ZZGG_Innovation_Project/OpenMAIC-main/docs/plans/2026-09-11-zhiyu-layout-avatars/assets/shuyan.png) | 1254×1254 | PNG，透明背景 |
| 思澈 | [siche.png](D:/ZZGG_Innovation_Project/OpenMAIC-main/docs/plans/2026-09-11-zhiyu-layout-avatars/assets/siche.png) | 1254×1254 | PNG，透明背景 |
| 默认用户 | [learner.png](D:/ZZGG_Innovation_Project/OpenMAIC-main/docs/plans/2026-09-11-zhiyu-layout-avatars/assets/learner.png) | 1254×1254 | PNG，透明背景 |

以上均为工具实际输出尺寸，不是提示词请求尺寸。已检查全部 7 张 PNG 可读取、宽高相等且四角透明。完整头部、简化五官与二维画风已逐张目视检查。源图约 0.7–0.9MB，尚未做发布压缩，也尚未在 Zhiyu 的实际 32–48px 圆形头像控件中验收；实施阶段按主方案导出小尺寸发布版并检查亮/暗主题。

## 生成方法与原始提示词

启衡先单独生成；其余六张仅使用这张新的启衡卡通作为风格参考，没有使用原 OpenMAIC 人物作为临摹对象。

风格参考源图：[qiheng.png](D:/ZZGG_Innovation_Project/OpenMAIC-main/docs/plans/2026-09-11-zhiyu-layout-avatars/assets/qiheng.png)。以下记录本轮最终版的实际完整提示词，供之后调整素材使用；提示词中的生成尺寸和部分细节是请求，实际文件以本页清单及目视结果为准。

### 启衡 / qiheng

```text
Create a FLAT TWO-DIMENSIONAL CARTOON AVATAR, like a charming hand-drawn chibi sticker in an indie educational app. This must look like a DRAWING made of flat color shapes and thick dark ink outlines. NOT a photograph, NOT 3D, NOT realistic, NOT a realistic AI drama actor, NOT semi-realistic portrait. Completely smooth flat fills: no skin texture, no individual hair strands, no fabric texture, no rendering gradients, no realistic anatomy. Square 1024x1024. One cartoon male teacher named Qi Heng: huge rounded head, tiny short shoulder bust, round bronze spectacles, simple dot eyes inside glasses, tiny curved nose, small smiling curve mouth, stylized chunky dark hair with ONE white graphic streak, navy Chinese stand-collar coat simplified to three flat shapes, cream shirt. Limited palette navy, teal, cream and pale blue. Big head with subtly asymmetrical silhouette, playful hand-inked curves, sophisticated gentle editorial illustration. Face readable at 32 pixels. Flat pale blue square background. Centered head and shoulders with 14 percent safe margin above and sides for circular cropping. No text, no lettering, no logo, no watermark, no extra symbols, no hands. Make it unmistakably a cute drawn cartoon with simple graphic design.
```

### 知微 / zhiwei

```text
Create one NEW original character avatar matching the attached image ONLY as a STYLE reference. Match its cute TWO-DIMENSIONAL chibi drawing, huge head and tiny shoulder bust, simplified oval eyes, small curved mouth, graphic chunky hair shapes, clear navy outlines, restrained cel shading and rounded silhouette. Absolutely no realism, no 3D, no realistic skin, hair strands or fabric texture, no cinematic AI actor. One character only, centered square 1280x1280, transparent background, 10% safe margins so whole hairstyle fits inside a circular crop. No text, logo, border, watermark, hands or props. Use a distinct silhouette, expression and color palette for this new person; do not copy the teacher's face, glasses or clothing. Female teaching assistant Zhi Wei, simple dark chin-length bob with tucked ends, crescent happy eyes, small warm smile, leaf-shaped sage hair clip, ivory cardigan with sage green top. Light peach skin. Calm and friendly.
```

### 悦扬 / yueyang

```text
Create one NEW original character avatar matching the attached image ONLY as a STYLE reference. Match its cute TWO-DIMENSIONAL chibi drawing, huge head and tiny shoulder bust, simplified oval eyes, small curved mouth, graphic chunky hair shapes, clear navy outlines, restrained cel shading and rounded silhouette. Absolutely no realism, no 3D, no realistic skin, hair strands or fabric texture, no cinematic AI actor. One character only, centered square 1280x1280, transparent background, 10% safe margins so whole hairstyle fits inside a circular crop. No text, logo, border, watermark, hands or props. Use a distinct silhouette, expression and color palette for this new person; do not copy the teacher's face, glasses or clothing. Playful female university classmate Yue Yang, bouncy dark brown short curls drawn as 6 big rounded graphic lobes, coral hair clip, one eyebrow lifted, wide cheerful smile, warm brown skin, coral varsity jacket with ivory collar. Energetic.
```

### 问熙 / wenxi

```text
Create one NEW original character avatar matching the attached image ONLY as a STYLE reference. Match its cute TWO-DIMENSIONAL chibi drawing, huge head and tiny shoulder bust, simplified oval eyes, small curved mouth, graphic chunky hair shapes, clear navy outlines, restrained cel shading and rounded silhouette. Absolutely no realism, no 3D, no realistic skin, hair strands or fabric texture, no cinematic AI actor. One character only, centered square 1280x1280, transparent background, 10% safe margins so whole hairstyle fits inside a circular crop. No text, logo, border, watermark, hands or props. Use a distinct silhouette, expression and color palette for this new person; do not copy the teacher's face, glasses or clothing. Curious male university classmate Wen Xi, tousled ochre brown chunky hair with a distinctive question-mark-shaped forelock, one raised eyebrow, simple wide oval eyes, tiny open curious mouth, golden yellow hoodie. Warm light skin.
```

### 书言 / shuyan

```text
Create one NEW original character avatar matching the attached image ONLY as a STYLE reference. Match its cute TWO-DIMENSIONAL chibi drawing, huge head and tiny shoulder bust, simplified oval eyes, small curved mouth, graphic chunky hair shapes, clear navy outlines, restrained cel shading and rounded silhouette. Absolutely no realism, no 3D, no realistic skin, hair strands or fabric texture, no cinematic AI actor. One character only, centered square 1280x1280, transparent background, 10% safe margins so whole hairstyle fits inside a circular crop. No text, logo, border, watermark, hands or props. Use a distinct silhouette, expression and color palette for this new person; do not copy the teacher's face, glasses or clothing. Studious female university classmate Shu Yan, very simple dark side braid made of 4 rounded shapes, oversized ivory oval glasses, small composed smile, dusty blue collared shirt. Light peach skin. Neat and kind.
```

### 思澈 / siche

```text
Create one NEW original character avatar matching the attached image ONLY as a STYLE reference. Match its cute TWO-DIMENSIONAL chibi drawing, huge head and tiny shoulder bust, simplified oval eyes, small curved mouth, graphic chunky hair shapes, clear navy outlines, restrained cel shading and rounded silhouette. Absolutely no realism, no 3D, no realistic skin, hair strands or fabric texture, no cinematic AI actor. One character only, centered square 1280x1280, transparent background, 10% safe margins so whole hairstyle fits inside a circular crop. No text, logo, border, watermark, hands or props. Use a distinct silhouette, expression and color palette for this new person; do not copy the teacher's face, glasses or clothing. Thoughtful female university classmate Si Che, asymmetrical deep navy short pixie hair, no glasses, calm half-moon eyes looking slightly upward, small reflective smile, muted plum turtleneck. Warm olive skin. Minimal distinctive silhouette.
```

### 默认用户 / learner

```text
Create one NEW original character avatar matching the attached image ONLY as a STYLE reference. Match its cute TWO-DIMENSIONAL chibi drawing, huge head and tiny shoulder bust, simplified oval eyes, small curved mouth, graphic chunky hair shapes, clear navy outlines, restrained cel shading and rounded silhouette. Absolutely no realism, no 3D, no realistic skin, hair strands or fabric texture, no cinematic AI actor. One character only, centered square 1280x1280, transparent background, 10% safe margins so whole hairstyle fits inside a circular crop. No text, logo, border, watermark, hands or props. Use a distinct silhouette, expression and color palette for this new person; do not copy the teacher's face, glasses or clothing. Gender-neutral young adult learner, dark simple short bowl-like layered hair with a teal small tuft, open friendly oval eyes, tiny cheerful smile, teal crewneck sweatshirt with ivory collar. Warm tan skin. Welcoming neutral default user avatar.
```
