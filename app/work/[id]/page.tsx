"use client";

import { useParams } from "next/navigation";
import WorkReport from "@/components/work/WorkReport";
import "@/components/work/work-report.css";

export default function WorkReportPage() {
  const params = useParams<{ id: string }>();
  return (
    <main className="work-report-page">
      <a href="/app">← Back to the office</a>
      {params?.id ? <WorkReport id={params.id} /> : <p>Missing report ID.</p>}
    </main>
  );
}
