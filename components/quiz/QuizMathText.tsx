'use client';

/**
 * Text with inline/display LaTeX (KaTeX), as quiz stems, options and
 * explanations write it. Shared by the classroom quiz and study papers.
 */
import { memo, useMemo } from 'react';

import { renderQuizMathText } from '@/lib/quiz/math-text';
import { cn } from '@/lib/utils';

export const QuizMathText = memo(function QuizMathText({
  text,
  className,
  allowDisplayMode = false,
  trustDelimiters = false,
}: {
  text: string;
  className?: string;
  allowDisplayMode?: boolean;
  /** Render every `$…$` span (see QuizMathTextOptions). */
  trustDelimiters?: boolean;
}) {
  const segments = useMemo(
    () => renderQuizMathText(text, { trustDelimiters }),
    [text, trustDelimiters],
  );
  if (segments.length === 1 && segments[0].type === 'text') {
    return <span className={className}>{segments[0].value}</span>;
  }

  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={index}>{segment.value}</span>;
        }

        return (
          <span
            key={index}
            className={cn(
              allowDisplayMode && segment.displayMode
                ? 'block my-1 overflow-x-auto [&_.katex-display]:!my-0'
                : 'inline-block align-baseline [&_.katex-display]:!my-0',
            )}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        );
      })}
    </span>
  );
});
