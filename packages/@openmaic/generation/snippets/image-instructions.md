### AI-Generated Image Requests

Use image generation only for slide scenes that need a static visual and have no suitable source image.

- Prefer `suggestedImageIds` when a suitable source/PDF image exists
- Add a `mediaGenerations` entry only when a generated image genuinely enhances the content
- Use `type: "image"`
- Each image request specifies: `prompt` (description for the generation model), `elementId` (unique placeholder), and optionally `aspectRatio` (default "16:9") and `style`
- **Image IDs**: use `"gen_img_1"`, `"gen_img_2"`, etc. IDs are globally unique across the entire course, not reset per scene
- The prompt should describe the desired image clearly and specifically
- **Language in images**: If the image contains text, labels, or annotations, the prompt must explicitly specify that all text in the image should be in the course language (for example, "all labels in Chinese" for zh-CN courses, "all labels in English" for en-US courses). For purely visual images without text, language does not matter
- **Avoid duplicate images across slides**: Each generated image must be visually distinct. Do not request near-identical images for different slides. If multiple slides cover the same topic, vary the visual angle, scope, or style
- **Cross-scene reuse**: To reuse a generated image in a different scene, reference the same `elementId` in the later scene's content without adding a new `mediaGenerations` entry. Only the scene that first defines the `elementId` in its `mediaGenerations` should include the generation request
- Use generated images for static content: illustrations, scenes, portraits, landscapes, conceptual diagrams whose meaning does not depend on exact geometry
- **Precise teaching visuals are NOT image requests**: image models cannot reliably draw exact counts, equal parts or correct labels. When the teaching point depends on any of the following, do NOT add a `mediaGenerations` entry; instead describe the exact figure in the scene's `description`/`keyPoints` (for example "Figure: a circle divided into 4 equal sectors, 1 sector shaded, labeled 1/4") so the slide is built from native shapes, lines, LaTeX and charts that render exactly:
  - fractions and equal partitions (fraction bars, circles/pizzas/squares split into equal parts, shaded parts)
  - exact quantities that learners must count (e.g. 7 apples, a 3 × 4 dot array)
  - number lines, rulers, scales, coordinate grids, clock faces showing a specific time
  - data charts with specific values, geometric figures with given lengths or angles
  - any figure whose labels, numbers or formula must be correct
- If a generated image must show countable objects, state the exact number ("exactly 5 apples") and do not ask the image model to write formulas or numeric labels

Image example:

```json
"mediaGenerations": [
  {
    "type": "image",
    "prompt": "A colorful diagram showing the water cycle with evaporation, condensation, and precipitation arrows",
    "elementId": "gen_img_1",
    "aspectRatio": "16:9"
  }
]
```
