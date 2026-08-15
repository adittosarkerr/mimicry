import { Hero } from '@/components/home/hero';
import { ExtensionCta } from '@/components/home/extension-cta';
import {
  ApiSection,
  Capabilities,
  ClosingCta,
  HowItWorks,
  OutputShowcase,
} from '@/components/home/sections';

export default function HomePage() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <Capabilities />
      {/* Straight after "how it works", because that is the moment somebody
          decides to try it and needs the recorder in their hands. */}
      <ExtensionCta />
      <OutputShowcase />
      <ApiSection />
      <ClosingCta />
    </>
  );
}
