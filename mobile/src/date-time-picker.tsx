import type { ChangeEvent } from 'react';

type DateTimePickerProps = {
  value: Date;
  onChange: (_event: unknown, selectedDate?: Date) => void;
};

export default function DateTimePicker({ value, onChange }: DateTimePickerProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedDate = event.currentTarget.valueAsDate;
    onChange(event, selectedDate ?? undefined);
  }

  return <input type="date" value={value.toISOString().slice(0, 10)} onChange={handleChange} />;
}
