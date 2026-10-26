export function RuntimeNotice({ detail, failed = false }: { detail: string; failed?: boolean }) {
  return (
    <section className="runtime-notice" role="status">
      <strong>{failed ? "Operation could not complete" : "Runtime setup required"}</strong>
      <p>
        {failed
          ? "Your input is preserved. Check the details before trying again."
          : "Execution is unavailable. Check Connection settings and the server protocol configuration."}
      </p>
      <details>
        <summary>Diagnostic details</summary>
        <p>{detail}</p>
      </details>
    </section>
  );
}
