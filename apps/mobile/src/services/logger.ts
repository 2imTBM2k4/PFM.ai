type LogLevel = 'debug' | 'info' | 'error';
type LogEntry = { level: LogLevel } & Record<string, string | number>;

const VALUES: Record<string, readonly string[]> = {
  action: [
    'confirm_open',
    'save_started',
    'save_committed',
    'save_published',
    'save_publication_skipped',
    'save_failed',
    'confirm_cancelled',
    'screen_blurred',
    'screen_unmounted',
    'save_in_history_page',
    'save_outside_history_page',
    'history_with_parsed',
    'history_without_parsed',
    'backup_duplicate_files',
    'backup_upload_succeeded',
    'backup_upload_failed',
    'backup_restore_succeeded',
    'backup_restore_failed',
  ],
  route: ['startup', 'database', 'lock', 'entry', 'backup'],
  status: ['loading', 'ready', 'failed'],
  errorCode: [
    'DATABASE_OPEN_FAILED',
    'LOCK_STORAGE_FAILED',
    'LOCK_STORAGE_READ_FAILED',
    'LOCK_STORAGE_WRITE_FAILED',
    'LOCK_STORAGE_DELETE_FAILED',
    'LOCK_STORAGE_PROBE_FAILED',
    'PIN_OPERATION_FAILED',
    'PIN_RECORD_INVALID',
    'PIN_VERIFIER_INVALID',
    'PIN_SALT_INVALID',
    'BACKUP_AUTH_REVOKED',
    'BACKUP_QUOTA_EXCEEDED',
    'BACKUP_VERIFY_FAILED',
    'BACKUP_NETWORK_FAILED',
    'BACKUP_UPLOAD_FAILED',
  ],
  nativeReason: [
    'INTERACTION_NOT_ALLOWED',
    'INVALID_PARAMETERS',
    'MISSING_ENTITLEMENT',
    'UNAVAILABLE',
    'UNKNOWN',
  ],
};

// Validate values as well as keys so an allowed field cannot smuggle user text.
export function createLogger(write: (entry: LogEntry) => void) {
  return (level: LogLevel, fields: Record<string, unknown>) => {
    const entry: LogEntry = { level };
    for (const [key, value] of Object.entries(fields)) {
      if (
        key === 'latency' &&
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0
      ) {
        entry[key] = value;
      } else if (typeof value === 'string' && VALUES[key]?.includes(value)) {
        entry[key] = value;
      } else {
        throw new Error('LOG_FIELD_REJECTED');
      }
    }
    write(entry);
  };
}

export const logAppEvent = createLogger((entry) => {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.info(entry);
});
