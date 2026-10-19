// 本文の Markdown（D-58）。react-markdown ＋ remark-gfm、生 HTML は描かない。リンクは http(s) だけ新しいタブで
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ href, children }) => {
    const safe = typeof href === "string" && /^https?:\/\//i.test(href);
    return safe ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  img: () => null,
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

function urlTransform(url: string): string {
  return /^(https?:|mailto:|#|\/)/i.test(url) ? url : "";
}

export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`.trim()}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
