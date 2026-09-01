"use client";

import { useEffect } from "react";

export function RedirectToSource({ sourceUrl }: { sourceUrl: string }) {
  useEffect(() => {
    window.location.replace(sourceUrl);
  }, [sourceUrl]);

  return (
    <main>
      <p>Opening the source listing…</p>
      <p>
        <a href={sourceUrl}>Continue to the listing</a>
      </p>
    </main>
  );
}
