import { type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

export default function Layout({ children }: Props) {
  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#020617",
        color: "#e2e8f0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      }}
    >
      <div style={{ width: "100%", maxWidth: "720px", padding: "1.5rem" }}>
        <div
          style={{
            backgroundColor: "rgba(15, 23, 42, 0.85)",
            borderRadius: "1.25rem",
            border: "1px solid #1e293b",
            boxShadow: "0 20px 45px rgba(0, 0, 0, 0.5)",
            padding: "1.5rem"
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
