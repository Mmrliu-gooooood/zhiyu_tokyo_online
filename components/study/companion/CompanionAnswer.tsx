'use client';

/**
 * Markdown answer of an after-class classmate (learning plan B05). Real models
 * answer in Markdown and write formulas in LaTeX ($…$, $$…$$), so the text goes
 * through Streamdown with the workbench chat's setup (CJK-friendly emphasis,
 * `.wb-prose` skin) plus math (KaTeX; its CSS is loaded by the root layout).
 * Each citation ([M3]) becomes a link that the caller renders as a reader link
 * or a withdrawn mark. The caller's renderer reaches the links through context:
 * Streamdown keeps rendered blocks while their text is unchanged, and only a
 * context change still re-renders a citation whose authorisation changed.
 */
import { createContext, useContext, type ReactNode } from 'react';
import {
  Streamdown,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type StreamdownProps,
} from 'streamdown';
import rehypeKatex from 'rehype-katex';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkMath from 'remark-math';

import { CITATION_HREF_PREFIX, answerMarkdown } from '@/lib/study/companion/fold';

// Streamdown's plugin props replace its defaults, so the defaults are re-spread.
const REMARK_PLUGINS = [remarkCjkFriendly, ...Object.values(defaultRemarkPlugins), remarkMath];
const REHYPE_PLUGINS: StreamdownProps['rehypePlugins'] = [
  ...Object.values(defaultRehypePlugins),
  [rehypeKatex, { strict: false, throwOnError: false }],
];
const CONTROLS = { table: false } as const;

const CitationRenderer = createContext<(ref: string) => ReactNode>((ref) => ref);

function Citation({ refId }: { refId: string }) {
  return useContext(CitationRenderer)(refId);
}

const COMPONENTS = {
  a: ({
    href,
    children,
    node: _node,
    ...anchor
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { readonly node?: unknown }) =>
    href?.startsWith(CITATION_HREF_PREFIX) ? (
      <Citation refId={href.slice(CITATION_HREF_PREFIX.length)} />
    ) : (
      <a href={href} target="_blank" rel="noreferrer" {...anchor}>
        {children}
      </a>
    ),
};

export function CompanionAnswer({
  text,
  streaming = false,
  renderCitation,
}: {
  text: string;
  streaming?: boolean;
  renderCitation: (ref: string) => ReactNode;
}) {
  if (!text) return null;
  return (
    <CitationRenderer.Provider value={renderCitation}>
      <div className="wbchat wb-prose">
        {/* Remounted when the stream ends: blocks rendered while incomplete
          (e.g. "[f(b)-f(a" completed into a blocked link) must not linger. */}
        <Streamdown
          key={streaming ? 'streaming' : 'done'}
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          controls={CONTROLS}
          components={COMPONENTS}
          parseIncompleteMarkdown={streaming}
        >
          {answerMarkdown(text)}
        </Streamdown>
      </div>
    </CitationRenderer.Provider>
  );
}
