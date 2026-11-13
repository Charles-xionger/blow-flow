import Image from "next/image";

export function BrandMark({ size = 32 }: { size?: number }) {
  return <Image src="/brand/ai-flow-mark.png" alt="" aria-hidden="true" width={size} height={size} unoptimized />;
}
