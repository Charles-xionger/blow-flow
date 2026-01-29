"use client";

import React from "react";
import { cn } from "@/lib/utils";

interface NodeInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  multiline?: boolean;
  rows?: number;
}

export function NodeInput({
  value,
  onChange,
  placeholder,
  disabled,
  multiline = false,
  rows = 3,
}: NodeInputProps) {
  const baseClasses = cn(
    "w-full px-3 py-2 text-sm border rounded-lg",
    "focus:outline-none focus:ring-2 focus:ring-primary",
    "bg-white dark:bg-gray-800",
    "border-gray-300 dark:border-gray-600",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  );

  if (multiline) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows}
        className={cn(baseClasses, "resize-none")}
      />
    );
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={baseClasses}
    />
  );
}
