import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Binary } from 'mongodb';

import { customType, string } from '@mica/db';

// Demo-only process-local key. Use a stable application-managed key for persisted data.
const key = randomBytes(32);

export const encrypted = customType({
  base: string,
  metadata: { encrypted: true },

  codec: {
    storedSchema: { bsonType: 'binData' },

    encode(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

      return new Binary(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
    },

    decode(value: Binary) {
      const bytes = Buffer.from(value.value());
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));

      decipher.setAuthTag(bytes.subarray(12, 28));

      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    },
  },
});
