export interface LockStorage {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
  checkWritable?(): Promise<void>;
}

interface PinRecord {
  version: 1;
  salt: string;
  verifier: string;
  attempts: number;
  blockedUntil: number;
  fast?: boolean;
}

function validatePin(pin: string) {
  if (!/^\d{6,12}$/.test(pin)) throw new Error('PIN_INVALID');
}

function equalVerifier(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export class PinLock {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: LockStorage,
    private readonly derive: (pin: string, salt: string) => Promise<string>,
    private readonly randomSalt: () => string,
    private readonly now: () => number,
    private readonly deriveLegacy?: (
      pin: string,
      salt: string,
    ) => Promise<string>,
  ) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(task);
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async read(): Promise<PinRecord | null> {
    const raw = await this.storage.get();
    if (raw === null) return null;
    try {
      const record: unknown = JSON.parse(raw);
      if (!record || typeof record !== 'object') throw new Error();
      const candidate = record as Partial<PinRecord>;
      if (
        candidate.version !== 1 ||
        typeof candidate.salt !== 'string' ||
        !/^[a-f0-9]{64}$/.test(candidate.salt) ||
        typeof candidate.verifier !== 'string' ||
        !/^[a-f0-9]{64}$/.test(candidate.verifier) ||
        typeof candidate.attempts !== 'number' ||
        !Number.isSafeInteger(candidate.attempts) ||
        candidate.attempts < 0 ||
        typeof candidate.blockedUntil !== 'number' ||
        !Number.isSafeInteger(candidate.blockedUntil) ||
        candidate.blockedUntil < 0
      ) {
        throw new Error();
      }
      return candidate as PinRecord;
    } catch {
      throw new Error('PIN_RECORD_INVALID');
    }
  }

  status() {
    return this.serialize(async () => {
      const record = await this.read();
      return {
        enabled: record !== null,
        attempts: record?.attempts ?? 0,
        blockedUntil: record?.blockedUntil ?? 0,
      };
    });
  }

  private async writeNewPin(pin: string) {
    const salt = this.randomSalt();
    if (!/^[a-f0-9]{64}$/.test(salt)) throw new Error('PIN_SALT_INVALID');
    const verifier = await this.derive(pin, salt);
    if (!/^[a-f0-9]{64}$/.test(verifier))
      throw new Error('PIN_VERIFIER_INVALID');
    const record: PinRecord = {
      version: 1,
      salt,
      verifier,
      attempts: 0,
      blockedUntil: 0,
      fast: true,
    };
    await this.storage.set(JSON.stringify(record));
  }

  enable(pin: string) {
    return this.serialize(async () => {
      validatePin(pin);
      if (await this.read()) throw new Error('PIN_ALREADY_ENABLED');
      await this.storage.checkWritable?.();
      await this.writeNewPin(pin);
    });
  }

  private async authenticate(pin: string) {
    validatePin(pin);
    const record = await this.read();
    if (!record) throw new Error('PIN_NOT_ENABLED');
    if (this.now() < record.blockedUntil) throw new Error('PIN_DELAYED');
    const attempts = Math.min(record.attempts + 1, 1000000);
    const delay =
      attempts < 3
        ? 0
        : Math.min(300000, 5000 * 2 ** Math.min(attempts - 3, 6));
    // Consume the retry before expensive work to survive interruption or force quit.
    await this.storage.set(
      JSON.stringify({ ...record, attempts, blockedUntil: this.now() + delay }),
    );
    const verifier = await this.derive(pin, record.salt);
    let matched = equalVerifier(verifier, record.verifier);
    if (!matched && !record.fast && this.deriveLegacy) {
      const legacyVerifier = await this.deriveLegacy(pin, record.salt);
      matched = equalVerifier(legacyVerifier, record.verifier);
    }
    if (!matched) return false;
    await this.storage.set(
      JSON.stringify({
        ...record,
        verifier,
        fast: true,
        attempts: 0,
        blockedUntil: 0,
      }),
    );
    return true;
  }

  verify(pin: string) {
    return this.serialize(() => this.authenticate(pin));
  }

  change(currentPin: string, nextPin: string) {
    return this.serialize(async () => {
      validatePin(nextPin);
      if (!(await this.authenticate(currentPin))) return false;
      await this.writeNewPin(nextPin);
      return true;
    });
  }

  disable(pin: string) {
    return this.serialize(async () => {
      if (!(await this.authenticate(pin))) return false;
      await this.storage.remove();
      return true;
    });
  }

  // Call only after confirmed local-data deletion has completed.
  resetAfterDataDeletion() {
    return this.serialize(() => this.storage.remove());
  }
}
