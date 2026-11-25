import { CopyButton } from "./CopyButton";

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlightJson(json: string) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of json.matchAll(JSON_TOKEN)) {
    const [text, str, colon, literal, num] = match;
    const index = match.index ?? 0;
    if (index > last) parts.push(json.slice(last, index));
    if (str) {
      parts.push(
        <span key={index} className={colon ? "tok-key" : "tok-string"}>
          {str}
        </span>
      );
      if (colon) parts.push(colon);
    } else if (literal) {
      parts.push(<span key={index} className="tok-literal">{literal}</span>);
    } else if (num) {
      parts.push(<span key={index} className="tok-number">{num}</span>);
    }
    last = index + text.length;
  }
  parts.push(json.slice(last));
  return parts;
}

export function CodeBlock({ label, data }: { label: string; data: unknown }) {
  const json = JSON.stringify(data, null, 2);
  return (
    <figure className="code-block">
      <figcaption className="code-block-bar">
        <span>{label}</span>
        <CopyButton value={json} />
      </figcaption>
      <pre>
        <code>{highlightJson(json)}</code>
      </pre>
    </figure>
  );
}
