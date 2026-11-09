import { useEffect, useState } from "react";
import { formatCountdown } from "../lib/format";

export function Countdown({ target, className = "" }: { target: number | null; className?: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!target) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [target]);

  return (
    <span className={`countdown ${className}`} dir="ltr">
      {formatCountdown(target, now)}
    </span>
  );
}
