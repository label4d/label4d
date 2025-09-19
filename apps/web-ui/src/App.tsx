import { useState } from 'react';
import { CoreProvider } from './lib/core-context';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { ThreeDViewport } from './views/ThreeDViewport';
import { TopDownViewport } from './views/TopDownViewport';

function AppContent(): JSX.Element {
  const [referenceImage, setReferenceImage] = useState<ImageBitmap | null>(null);
  return (
    <div className="flex h-screen w-full flex-col">
      <Toolbar onReferenceImageLoaded={setReferenceImage} />
      <div className="flex flex-1 flex-row overflow-hidden">
        <div className="flex-1 border-r border-border bg-secondary/20">
          <ThreeDViewport />
        </div>
        <div className="flex-1 bg-secondary/30">
          <TopDownViewport referenceImage={referenceImage} />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <CoreProvider>
      <AppContent />
    </CoreProvider>
  );
}
