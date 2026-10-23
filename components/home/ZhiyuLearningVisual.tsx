import { cn } from '@/lib/utils/cn';

export function ZhiyuLearningVisual({ className }: { readonly className?: string }) {
  return (
    <svg
      data-testid="zhiyu-learning-visual"
      className={cn('h-auto w-full', className)}
      viewBox="0 0 360 240"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M78 128C112 90 145 76 181 87C219 99 234 128 279 119"
        fill="none"
        stroke="var(--ai)"
        strokeDasharray="5 7"
        strokeLinecap="round"
        strokeOpacity=".38"
        strokeWidth="2"
      />
      <path
        d="M102 171C145 155 167 161 197 184C219 201 251 194 277 166"
        fill="none"
        stroke="var(--primary)"
        strokeLinecap="round"
        strokeOpacity=".3"
        strokeWidth="2"
      />

      <g transform="translate(45 82)">
        <rect width="84" height="64" rx="15" fill="var(--card)" stroke="var(--border)" />
        <rect x="14" y="14" width="43" height="6" rx="3" fill="var(--primary)" opacity=".82" />
        <rect x="14" y="28" width="57" height="5" rx="2.5" fill="var(--border)" />
        <rect x="14" y="39" width="36" height="5" rx="2.5" fill="var(--border)" />
        <circle cx="68" cy="48" r="7" fill="var(--review-soft)" />
        <path
          d="m65 48 2 2 4-5"
          fill="none"
          stroke="var(--review)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </g>

      <g transform="translate(142 45)">
        <rect width="91" height="77" rx="18" fill="var(--primary)" />
        <circle cx="45.5" cy="28" r="11" fill="white" opacity=".94" />
        <circle cx="45.5" cy="28" r="4" fill="var(--primary)" />
        <path
          d="M45.5 17V9M34.5 28h-8M56.5 28h8M38 20.5l-6-6M53 20.5l6-6"
          stroke="white"
          strokeLinecap="round"
          strokeWidth="2"
          opacity=".72"
        />
        <rect x="19" y="51" width="53" height="6" rx="3" fill="white" opacity=".78" />
        <rect x="27" y="63" width="37" height="5" rx="2.5" fill="white" opacity=".38" />
      </g>

      <g transform="translate(242 82)">
        <rect width="75" height="61" rx="15" fill="var(--ai-soft)" />
        <circle cx="22" cy="22" r="8" fill="var(--ai)" />
        <rect x="36" y="18" width="24" height="5" rx="2.5" fill="var(--ai)" opacity=".62" />
        <rect x="15" y="39" width="45" height="6" rx="3" fill="var(--ai)" opacity=".24" />
      </g>

      <g transform="translate(120 157)">
        <rect width="78" height="50" rx="14" fill="var(--peer-soft)" />
        <circle cx="20" cy="25" r="8" fill="var(--peer)" opacity=".8" />
        <rect x="34" y="18" width="29" height="5" rx="2.5" fill="var(--peer)" opacity=".62" />
        <rect x="34" y="29" width="20" height="5" rx="2.5" fill="var(--peer)" opacity=".3" />
      </g>

      <g transform="translate(217 154)">
        <rect width="67" height="48" rx="14" fill="var(--review-soft)" />
        <path
          d="M17 31V18M27 31V13M37 31V22M47 31V16"
          stroke="var(--review)"
          strokeLinecap="round"
          strokeWidth="5"
        />
      </g>

      <circle cx="78" cy="128" r="5" fill="var(--primary)" />
      <circle cx="278" cy="119" r="5" fill="var(--ai)" />
      <circle cx="198" cy="184" r="5" fill="var(--peer)" />
    </svg>
  );
}
