/**
 * Safe date parsing and formatting utility to prevent Android / Hermes runtime exceptions.
 * Handles ISO strings, legacy timestamps, null/undefined, and invalid date formats gracefully.
 */
export function safeFormatDate(dateInput: string | number | Date | null | undefined, includeTime = true): string {
  if (!dateInput) return 'N/A';

  try {
    let d: Date;
    if (typeof dateInput === 'string') {
      // Normalize space-separated dates to ISO standard
      const normalized = dateInput.includes(' ') && !dateInput.includes('T')
        ? dateInput.replace(' ', 'T')
        : dateInput;
      d = new Date(normalized);
    } else {
      d = new Date(dateInput);
    }

    if (isNaN(d.getTime())) {
      return 'N/A';
    }

    return includeTime ? d.toLocaleString() : d.toLocaleDateString();
  } catch {
    return 'N/A';
  }
}

export function toISOStringSafe(dateInput: any): string {
  if (!dateInput) return new Date().toISOString();
  try {
    const date = new Date(dateInput);
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
  } catch {}
  return new Date().toISOString();
}
