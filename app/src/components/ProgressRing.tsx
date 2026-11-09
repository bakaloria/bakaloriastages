import { formatNumber, formatPercent, progressRatio } from "../lib/format";

interface ProgressRingProps {
  value: number;
  total: number;
  size?: number;
  stroke?: number;
  label?: string;
  sublabel?: string;
  tone?: "green" | "gold";
}

export function ProgressRing({
  value,
  total,
  size = 132,
  stroke = 10,
  label,
  sublabel,
  tone = "green",
}: ProgressRingProps) {
  const ratio = progressRatio(value, total);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - ratio);

  return (
    <div className={`progress-ring progress-ring--${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          className="progress-ring__track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="progress-ring__value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="progress-ring__content">
        <strong>{formatPercent(value, total)}</strong>
        {label ? <span>{label}</span> : null}
        {sublabel ? <small>{sublabel}</small> : null}
      </div>
      <span className="sr-only">
        {formatNumber(value)} من {formatNumber(total)}
      </span>
    </div>
  );
}
