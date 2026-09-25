'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function AuthField({
  id,
  label,
  type,
  autoComplete,
  value,
  onChange,
  minLength,
  readOnly,
}: {
  id: string;
  label: string;
  type: string;
  autoComplete: string;
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        autoCapitalize={type === 'email' ? 'none' : undefined}
        autoCorrect={type === 'email' ? 'off' : undefined}
        spellCheck={type === 'email' ? false : undefined}
        inputMode={type === 'email' ? 'email' : undefined}
        value={value}
        minLength={minLength}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        required={!readOnly}
      />
    </div>
  );
}
