export function FullScreenLoader({ label = "جارٍ التحميل..." }: { label?: string }) {
  return (
    <div className="full-screen-loader">
      <div className="loader-orbit" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p>{label}</p>
    </div>
  );
}

export function InlineLoader({ label = "جارٍ التحميل..." }: { label?: string }) {
  return (
    <div className="inline-loader">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
