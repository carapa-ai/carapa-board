import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import carapaBotIcon from '@/assets/carapa-bot.png';

interface RuntimeHarnessIconProps {
  icon?: string;
  className?: string;
}

export function RuntimeHarnessIcon({ icon, className }: RuntimeHarnessIconProps) {
  const [failed, setFailed] = useState(false);
  const source = icon === '@/assets/carapa-bot.png' ? carapaBotIcon : icon;

  useEffect(() => setFailed(false), [source]);

  if (!source || failed) {
    return <Bot aria-hidden="true" className={className} />;
  }

  return (
    <img
      src={source}
      alt=""
      className={cn('object-contain', className)}
      onError={() => setFailed(true)}
    />
  );
}
