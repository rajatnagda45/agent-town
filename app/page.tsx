"use client";

import dynamic from "next/dynamic";

const LandingPageV2 = dynamic(() => import("@/components/landing/v2/LandingPageV2"), {
  ssr: false,
});

export default function Page() {
  return <LandingPageV2 />;
}
