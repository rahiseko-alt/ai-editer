import type { ButtonHTMLAttributes } from "react";

export function Button({
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-black/80 ${className}`}
      {...props}
    />
  );
}
