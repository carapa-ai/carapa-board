import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Select, SelectItem } from '@/components/ui/select';
import { useAppConfig } from '@/hooks/use-app-config';

export interface SpeechLanguageOption {
  code: string;
  label: string;
}

/** Speech-to-text languages: a default entry (code ''), "Auto-detect" unless
 * the operator already lists it, then the configured meeting languages. */
export function useSpeechLanguageOptions(
  defaultLabel = 'Default language',
): SpeechLanguageOption[] {
  const { data: config } = useAppConfig();
  return useMemo(() => {
    const configured = config?.meetingLanguages ?? [];
    return [
      { code: '', label: defaultLabel },
      ...(configured.some((language) => language.code.toLowerCase() === 'auto')
        ? []
        : [{ code: 'auto', label: 'Auto-detect' }]),
      ...configured,
    ];
  }, [config, defaultLabel]);
}

/** Compact "RO" / "Auto" label whose invisible select opens the language list. */
export function ListeningLanguagePicker({
  dataUi,
  selectDataUi,
  language,
  value,
  options,
  title,
  ariaLabel,
  compactBelowMd = false,
  onChange,
  ...dataAttributes
}: {
  dataUi: string;
  selectDataUi: string;
  /** Language the capture is actually using ('auto' or a code). */
  language: string;
  /** The explicit choice ('' = default). */
  value: string;
  options: SpeechLanguageOption[];
  title: string;
  ariaLabel: string;
  /** Below `md`, show only the language code; the select becomes an invisible overlay. */
  compactBelowMd?: boolean;
  onChange: (code: string) => void;
  'data-engine'?: string;
}) {
  return (
    <label
      data-ui={dataUi}
      data-language={language}
      {...dataAttributes}
      className={cn(
        'relative cursor-pointer rounded px-1 text-xs font-medium text-muted-foreground hover:text-foreground',
        compactBelowMd &&
          '@max-md:inline-flex @max-md:h-9 @max-md:items-center @max-md:px-2',
      )}
      title={title}
    >
      {language === 'auto' ? 'Auto' : language.toUpperCase()}
      <Select
        data-ui={selectDataUi}
        aria-label={ariaLabel}
        className={cn(
          compactBelowMd &&
            '@max-md:absolute @max-md:inset-0 @max-md:size-full @max-md:opacity-0',
        )}
        value={value}
        onValueChange={(nextValue) => onChange(nextValue)}
      >
        {options.map((option) => (
          <SelectItem key={option.code} value={option.code}>
            {option.label}
          </SelectItem>
        ))}
      </Select>
    </label>
  );
}
