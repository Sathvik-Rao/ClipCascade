// The saved preference remains an integer byte count; an empty string means no local limit.
export const NO_LOCAL_LIMIT = 'No local limit';
export const LIMIT_UNITS = {Bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3};

export const parseClipboardLimit = (amount, unit) => {
  if (unit === NO_LOCAL_LIMIT || (Object.prototype.hasOwnProperty.call(LIMIT_UNITS, unit) && amount.trim() === '')) {
    return '';
  }
  if (!Object.prototype.hasOwnProperty.call(LIMIT_UNITS, unit) || !/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(amount.trim())) {
    throw new Error('Enter a positive number, or leave blank for no local limit.');
  }
  const value = Number(amount) * LIMIT_UNITS[unit];
  const bytes = Math.round(value);
  if (value <= 0 || value > Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new Error('Choose a limit of at least 1 byte and less than 8 PiB.');
  }
  return String(bytes);
};

export const formatClipboardLimit = (value, display) => {
  const bytes = value == null ? '' : String(value);
  if (typeof display?.amount === 'string' && typeof display.unit === 'string') {
    try {
      if (parseClipboardLimit(display.amount, display.unit) === bytes) {
        return display;
      }
    } catch {
      // Invalid saved display values fall back to Bytes.
    }
  }
  return {amount: bytes, unit: 'Bytes'};
};
