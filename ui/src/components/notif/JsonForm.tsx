import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Select, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DialogFooter } from '@/components/ui/dialog';

/**
 * Renders a form from a JSON Schema (subset). The accepted shape mirrors what
 * payload-store.ts validates server-side — keep them in sync if you change either.
 */

interface FieldSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean';
  title?: string;
  description?: string;
  default?: string | number | boolean;
  enum?: Array<string | number>;
  format?: 'email' | 'uri' | 'tel' | 'date' | 'multiline';
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

interface FormSchema {
  type: 'object';
  title?: string;
  description?: string;
  properties: Record<string, FieldSchema>;
  required?: string[];
  submit_label?: string;
}

export interface JsonFormProps {
  schema: FormSchema;
  onSubmit: (
    values: Record<string, string | number | boolean>,
  ) => void | Promise<void>;
  submitting?: boolean;
  /** Messages for single fields from the server, keyed by property name. */
  fieldErrors?: Record<string, string>;
  /** Message about the whole submission, shown above the buttons. */
  error?: string | null;
  /** Rendered before the submit button (cancel, decline). */
  secondaryAction?: ReactNode;
  /** Heading of the surrounding dialog; a schema title that repeats it is dropped. */
  dialogTitle?: string;
  /** Focus the first field on mount (desktop pointers only). */
  autoFocusFirstField?: boolean;
}

type ControlKind =
  | 'text'
  | 'email'
  | 'url'
  | 'tel'
  | 'date'
  | 'number'
  | 'textarea'
  | 'select'
  | 'checkbox';

function controlKindFor(field: FieldSchema): ControlKind {
  if (field.type === 'boolean') return 'checkbox';
  if (field.enum && field.enum.length > 0) return 'select';
  if (field.type === 'number' || field.type === 'integer') return 'number';
  if (field.format === 'email') return 'email';
  if (field.format === 'uri') return 'url';
  if (field.format === 'tel') return 'tel';
  if (field.format === 'date') return 'date';
  if (field.format === 'multiline') return 'textarea';
  return 'text';
}

function defaultFor(field: FieldSchema): string | number | boolean {
  if (field.default !== undefined) return field.default;
  if (field.type === 'boolean') return false;
  if (field.type === 'number' || field.type === 'integer')
    return '' as unknown as number;
  return '';
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
}

/** True when one title's words all appear in the other: the same heading twice. */
function repeatsTitle(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  const [small, big] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return small.length === 0 || small.every((w) => big.includes(w));
}

const SELECT_CLASS = 'w-full min-w-0';

export function JsonForm({
  schema,
  onSubmit,
  submitting = false,
  fieldErrors,
  error,
  secondaryAction,
  dialogTitle,
  autoFocusFirstField = false,
}: JsonFormProps) {
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const propertyEntries = Object.entries(properties);
  const formRef = useRef<HTMLFormElement>(null);

  const [values, setValues] = useState<
    Record<string, string | number | boolean>
  >(() => {
    const initial: Record<string, string | number | boolean> = {};
    for (const [name, f] of propertyEntries) {
      initial[name] = defaultFor(f);
    }
    return initial;
  });
  // Validation messages shown next to their field (browser validation message
  // on submit, or the server's message for that property).
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (fieldErrors) setErrors((prev) => ({ ...prev, ...fieldErrors }));
  }, [fieldErrors]);

  useEffect(() => {
    if (!autoFocusFirstField) return;
    if (!window.matchMedia?.('(pointer: fine)').matches) return;
    formRef.current
      ?.querySelector<HTMLElement>('input,select,textarea,[role=checkbox]')
      ?.focus();
  }, [autoFocusFirstField]);

  function set(name: string, v: string | number | boolean) {
    setValues((prev) => ({ ...prev, [name]: v }));
    setErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    // The form has noValidate: report every invalid field next to itself
    // instead of the browser's single bubble on the first one.
    const invalid: Record<string, string> = {};
    const controlOf = (name: string) =>
      formRef.current?.elements.namedItem(`notif-field-${name}`) as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
        | null;
    for (const [name] of propertyEntries) {
      const control = controlOf(name);
      if (control?.checkValidity && !control.checkValidity()) {
        invalid[name] = control.validationMessage || 'Invalid value';
      }
    }
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      const first = propertyEntries.find(([name]) => name in invalid)?.[0];
      if (first) controlOf(first)?.focus();
      return;
    }
    setErrors({});

    // Strip empty optional strings so they don't get persisted as "" when the
    // schema would have allowed the property to be missing entirely.
    const clean: Record<string, string | number | boolean> = {};
    for (const [name, raw] of Object.entries(values)) {
      const field = properties[name];
      if (typeof raw === 'string' && raw === '' && !required.has(name))
        continue;
      // Coerce empty number inputs to 0 only when required; otherwise omit.
      if (
        (field?.type === 'number' || field?.type === 'integer') &&
        (raw as unknown) === ''
      ) {
        if (required.has(name)) clean[name] = 0;
        continue;
      }
      clean[name] = raw;
    }
    await onSubmit(clean);
  }

  const titleAddsInfo =
    !!schema?.title &&
    !(dialogTitle && repeatsTitle(schema.title, dialogTitle));

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      data-ui="notification-form"
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      {/* The fields scroll; the buttons below stay on screen. The negative
          margin keeps field focus rings from being clipped by the scroller. */}
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 py-1">
        {titleAddsInfo ? (
          <p className="text-sm font-medium">{schema.title}</p>
        ) : null}
        {schema?.description ? (
          <p className="text-sm text-muted-foreground">{schema.description}</p>
        ) : null}
        {required.size > 0 ? (
          <p className="text-xs text-muted-foreground">
            <span aria-hidden="true" className="text-destructive">
              *
            </span>{' '}
            Required
          </p>
        ) : null}

        {propertyEntries.map(([name, field]) => {
          const id = `notif-field-${name}`;
          const label = field.title ?? name;
          const isRequired = required.has(name);
          const kind = controlKindFor(field);
          const message = errors[name];
          const descriptionId = field.description ? `${id}-help` : undefined;
          const describedBy =
            [descriptionId, message ? `${id}-error` : undefined]
              .filter(Boolean)
              .join(' ') || undefined;
          const aria = {
            'aria-invalid': message ? true : undefined,
            'aria-describedby': describedBy,
          };

          const marker = isRequired ? (
            <>
              {/* The required attribute already tells assistive tech. */}
              <span aria-hidden="true" className="text-destructive">
                {' '}
                *
              </span>
            </>
          ) : null;
          const labelEl = (
            <label htmlFor={id} className="text-sm font-medium">
              {label}
              {marker}
            </label>
          );
          const helpEl = field.description ? (
            <p id={descriptionId} className="text-xs text-muted-foreground">
              {field.description}
            </p>
          ) : null;
          const errorEl = message ? (
            <p
              id={`${id}-error`}
              role="alert"
              data-ui="notification-field-error"
              className="text-xs text-destructive"
            >
              {message}
            </p>
          ) : null;

          if (kind === 'checkbox') {
            return (
              <div key={name} className="flex flex-col gap-1">
                <label htmlFor={id} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    className="size-6 rounded-md"
                    checked={Boolean(values[name])}
                    onCheckedChange={(v) => set(name, Boolean(v))}
                    {...aria}
                  />
                  <span className="text-sm">
                    {label}
                    {marker}
                  </span>
                </label>
                {helpEl}
                {errorEl}
              </div>
            );
          }

          if (kind === 'textarea') {
            return (
              <div key={name} className="flex flex-col gap-1">
                {labelEl}
                <Textarea
                  id={id}
                  value={String(values[name] ?? '')}
                  required={isRequired}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  rows={3}
                  onChange={(e) => set(name, e.target.value)}
                  onKeyDown={(e) => {
                    // Enter adds a line here, so Ctrl/Cmd+Enter submits.
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      formRef.current?.requestSubmit();
                    }
                  }}
                  {...aria}
                />
                {helpEl}
                {errorEl}
              </div>
            );
          }

          if (kind === 'select') {
            return (
              <div key={name} className="flex flex-col gap-1">
                {labelEl}
                <Select
                  id={id}
                  value={String(values[name] ?? '')}
                  required={isRequired}
                  onValueChange={(nextValue) =>
                    // Numeric enums submit the number, not its string label.
                    set(
                      name,
                      (field.enum ?? []).find(
                        (opt) => String(opt) === nextValue,
                      ) ?? nextValue,
                    )
                  }
                  className={SELECT_CLASS}
                  {...aria}
                >
                  <SelectItem value="">Select…</SelectItem>
                  {(field.enum ?? []).map((opt) => (
                    <SelectItem key={String(opt)} value={String(opt)}>
                      {String(opt)}
                    </SelectItem>
                  ))}
                </Select>
                {helpEl}
                {errorEl}
              </div>
            );
          }

          return (
            <div key={name} className="flex flex-col gap-1">
              {labelEl}
              <Input
                id={id}
                type={kind}
                value={String(values[name] ?? '')}
                required={isRequired}
                minLength={field.minLength}
                maxLength={field.maxLength}
                pattern={field.pattern}
                min={field.minimum}
                max={field.maximum}
                // Integers keep the browser's step of 1; decimals are valid.
                step={field.type === 'number' ? 'any' : undefined}
                onChange={(e) => {
                  const next =
                    kind === 'number'
                      ? e.target.value === ''
                        ? ''
                        : Number(e.target.value)
                      : e.target.value;
                  set(name, next as string | number);
                }}
                {...aria}
              />
              {helpEl}
              {errorEl}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-3">
        {error ? (
          <p
            role="alert"
            data-ui="notification-form-error"
            className="text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {secondaryAction}
          <Button type="submit" disabled={submitting} className="max-md:h-11">
            {submitting && (
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            )}
            {submitting ? 'Submitting…' : (schema?.submit_label ?? 'Submit')}
          </Button>
        </DialogFooter>
      </div>
    </form>
  );
}
