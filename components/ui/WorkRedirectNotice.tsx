import Link from "next/link";

/** A seat request that needs data was sent to the verified work pipeline; no seat task exists. */
export function WorkRedirectNotice({
  redirect,
}: {
  redirect?: { composerTaskId: string; reason: string };
}) {
  if (!redirect) return null;
  return (
    <section className="runtime-notice" role="status">
      <strong>Sent to the verified work pipeline</strong>
      <p>{redirect.reason}</p>
      <p>
        <Link href={`/work/${encodeURIComponent(redirect.composerTaskId)}`}>
          Open the Work report
        </Link>
      </p>
    </section>
  );
}
