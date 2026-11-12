import type { ReactNode } from "react";

interface AnnouncementContentProps {
  title: string;
  body: string;
  banner?: boolean;
  heading?: "strong" | "h2";
  meta?: ReactNode;
}

const TICKER_COPIES = 3;

export function AnnouncementContent({
  title,
  body,
  banner = false,
  heading = "strong",
  meta,
}: AnnouncementContentProps) {
  const metaNode = meta ? <div className="notice__meta">{meta}</div> : null;

  if (!banner) {
    const Heading = heading === "h2" ? "h2" : "strong";
    return (
      <div className="notice__content">
        {metaNode}
        <Heading>{title}</Heading>
        <p>{body}</p>
      </div>
    );
  }

  return (
    <div className="notice__content notice__content--banner">
      {metaNode}
      <div className="notice__ticker">
        {Array.from({ length: TICKER_COPIES }, (_, index) => (
          <span
            className="notice__ticker-item"
            key={index}
            aria-hidden={index > 0 ? true : undefined}
          >
            <strong>{title}</strong>
            <span className="notice__ticker-body">{body}</span>
            <span className="notice__ticker-separator" aria-hidden="true">
              ✦
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
