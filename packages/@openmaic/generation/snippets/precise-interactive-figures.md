## Exact Math Figures (fractions, equal parts, counts, clocks)

If the widget shows a figure whose correctness depends on exact parts, counts or positions, compute it from the numbers in the scene description; never approximate or draw a fixed decorative grid.

- **Parts come from the fraction**: a fraction a/b is drawn with exactly b equal parts and a highlighted. A grid for b parts uses rows × cols = b (e.g. 2/4 → 2 × 2 or 1 × 4; never 3 × 3). Equivalent fractions (2/4 = 1/2) are shown as two separate figures of the same total size, each with its own part count.
- **Generate parts in a loop** from the denominator (`for (let i = 0; i < b; i++)`), with equal widths/angles computed as `size / b` or `360 / b`; the figure updates when the learner changes the numbers.
- **Clock faces**: 12 numbers at angle 30° × k; minute hand at 6° × m, hour hand at 30° × (h mod 12) + 0.5° × m; hour hand shorter.
- **Fit, never clip**: size the figure from the container (`Math.min(width, height)` with padding, recomputed on resize); every part and label must be fully visible on a 375 px wide screen. Do not use fixed pixel sizes that overflow.
- Before output, check that part counts, highlighted counts and labels in the code match the scene description.
