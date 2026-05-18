export function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string;
}) {
  return (
    <div className="stat">
      <div className={`stat-value ${accent ?? ""}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
