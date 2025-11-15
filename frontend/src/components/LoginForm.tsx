interface Props {
  name: string;
  onChange: (val: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export default function LoginForm({ name, onChange, onSubmit }: Props) {
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "1rem" }}>
      <div style={{ display: "grid", gap: "0.25rem" }}>
        <label style={{ fontSize: "0.9rem", fontWeight: 500 }}>
          Nome giocatore
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Es. Pippo, Nico, Mira..."
          style={{
            width: "100%",
            borderRadius: "0.5rem",
            border: "1px solid #1f2933",
            backgroundColor: "#020617",
            padding: "0.5rem 0.75rem",
            color: "#e2e8f0",
            fontSize: "0.9rem",
            outline: "none"
          }}
        />
      </div>
      <button
        type="submit"
        style={{
          width: "100%",
          borderRadius: "0.5rem",
          backgroundColor: "#22c55e",
          color: "#020617",
          fontWeight: 600,
          padding: "0.5rem 0.75rem",
          fontSize: "0.9rem",
          border: "none",
          cursor: "pointer"
        }}
      >
        Entra
      </button>
    </form>
  );
}
