import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge conditional class names, de-duplicating conflicting Tailwind utilities.
 * Standard shadcn helper used by the vendored `src/components/ui` kit.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
