"use client";

import { cn } from "@/lib/utils";

interface NodeSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}

export function NodeSelect({
  value,
  onChange,
  options,
  disabled,
}: NodeSelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={cn(
        "w-full px-3 py-2 text-sm border rounded-lg",
        "focus:outline-none focus:ring-2 focus:ring-primary",
        "bg-white dark:bg-gray-800",
        "border-gray-300 dark:border-gray-600",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
