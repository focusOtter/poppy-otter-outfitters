"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "../debug/CopyButton";

const POLL_MS = 5000;

function shoppingPrompt(origin: string) {
  return [
    `Shop for me at ${origin}.`,
    `The store speaks the Poppy protocol: start by reading ${origin}/.well-known/poppy.json to discover its API and how to identify yourself.`,
    "Browse the catalog, add what I ask for to the cart, and ask me to approve the connection and the order before you check out.",
  ].join(" ");
}

// Shown until the first agent joins. Refreshes the page quietly so a new agent appears without a reload.
export function AgentEmptyState({ origin }: { origin: string }) {
  const router = useRouter();
  const prompt = shoppingPrompt(origin);

  useEffect(() => {
    const id = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [router]);

  return (
    <div className="agent-empty">
      <p className="agent-looking" role="status">
        <span className="agent-pulse" aria-hidden="true" />
        Looking for an agent…
      </p>

      <ol className="agent-steps">
        <li>
          <strong>Copy the prompt below.</strong> It points your agent at this store&apos;s Poppy discovery file.
        </li>
        <li>
          <strong>Paste it into any Poppy-compatible agent</strong>, such as poppyplayground or your own eve agent.
        </li>
        <li>
          <strong>Approve the connection</strong> when the agent asks you to sign in. It can shop and check out, never change your
          account.
        </li>
        <li>
          <strong>Watch it appear here</strong>, with everything it does listed under recent activity.
        </li>
      </ol>

      <figure className="code-block">
        <figcaption className="code-block-bar">
          <span>Prompt for your agent</span>
          <CopyButton value={prompt} label="Copy prompt" />
        </figcaption>
        <pre className="prompt-text">
          <code>{prompt}</code>
        </pre>
      </figure>

      <p className="muted agent-discovery">
        Discovery file:{" "}
        <a href={`${origin}/.well-known/poppy.json`} target="_blank" rel="noreferrer">
          <code>{origin}/.well-known/poppy.json</code>
        </a>
      </p>
    </div>
  );
}
