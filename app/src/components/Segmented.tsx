export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { v: T; l: string }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          className={`seg ${value === o.v ? "active" : ""}`}
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}
