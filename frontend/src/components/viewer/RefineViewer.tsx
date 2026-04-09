'use client';

import { useRef, useState, useCallback } from 'react';
import SplatViewerCore, { SplatViewerCoreRef } from './SplatViewerCore';
import { useRefineTool } from './tools/useRefineTool';

interface RefineViewerProps {
  sogUrl: string;
  uploadId?: string;
}

export default function RefineViewer({ sogUrl, uploadId }: RefineViewerProps) {
  const coreRef = useRef<SplatViewerCoreRef>(null);
  const [currentUrl, setCurrentUrl] = useState(sogUrl);
  const [reloadKey, setReloadKey] = useState(0);

  const reloadWithUrl = useCallback((newUrl: string) => {
    setCurrentUrl(newUrl);
    setReloadKey(k => k + 1);
  }, []);

  const refine = useRefineTool(coreRef, { uploadId, reloadWithUrl });

  return (
    <SplatViewerCore
      key={reloadKey}
      ref={coreRef}
      sogUrl={currentUrl}
      onSplatLoaded={refine.onSplatLoaded}
    >
      {refine.ui}
    </SplatViewerCore>
  );
}
