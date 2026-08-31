/**
 * Firestore client wrapper. Initialized once at module load;
 * the Cloud Function runtime provides the service-account
 * credentials, and the local emulator is supported via
 * FIRESTORE_EMULATOR_HOST.
 */

import { initializeApp, getApps, applicationDefault, cert, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

let app: App | null = null;
let db: Firestore | null = null;
let settingsApplied = false;

export function getDb(): Firestore {
  if (db) return db;
  if (!app) {
    if (getApps().length === 0) {
      const projectId =
        process.env.GCLOUD_PROJECT ?? process.env.WORKTRACKER_PROJECT_ID ?? 'worktracker-local';
      // When running against the Firestore emulator, the Admin
      // SDK still requires *some* credential object. A dummy
      // service-account-shaped object is enough — the emulator
      // ignores the signature and routes by project ID.
      const credential = process.env.FIRESTORE_EMULATOR_HOST
        ? cert({
            projectId,
            clientEmail: `fake@${projectId}.iam.gserviceaccount.com`,
            // A structurally-valid but untrusted RSA test key.
            // The emulator never verifies the signature.
            privateKey: DUMMY_PRIVATE_KEY,
          })
        : applicationDefault();
      app = initializeApp({ credential, projectId });
    } else {
      app = getApps()[0]!;
    }
  }
  db = getFirestore(app);
  // Firestore's `settings()` is one-shot per underlying instance —
  // re-applying it on a re-initialized `db` (e.g. after
  // `resetDbForTest()`) throws. Guard with a flag so the brain
  // can still call `getDb()` between tests.
  if (!settingsApplied) {
    // Allow .set() calls to drop undefined fields instead of
    // rejecting them — every command constructor leaves fields
    // like `body.source_meta` undefined when not provided, and
    // serializing those as null would change the on-the-wire
    // shape of the data model.
    db.settings({ ignoreUndefinedProperties: true });
    settingsApplied = true;
  }
  return db;
}

/** Test-only override. */
export function setDbForTest(testDb: Firestore): void {
  db = testDb;
}

/** Test-only override. */
export function resetDbForTest(): void {
  db = null;
  app = null;
}

const DUMMY_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDL5atvwA9g9Dz0
ba5ytSh/VQ04C2lo4cZNQpUqiiRwcHXTehMJ/fbpVoTtg7Mw2c5qjlZ9b7vsJN9f
mA1KltQr6swzLyzHh9WkxTq/aNd8zJq7fwOF/qpefA2LA0Jt8+cY8xPPj2kfR/3g
qbGu1FAo6En42d/8pEo5eXVbIsFJAlJtiZn7GeZ27V+mIguquAqYkf4XPYv3v0XG
Knx+UpkVBWzL82Fsp6Bc7hWuZCF+4rJF7rOQDBRPtG9yRZ+jEEWllpM66hDxKK41
AxTQaQKl4By2EzD/Acd0zFy/Jc9VXp6bkNWHXnpGx3sOeisvt4brn7y94g+w2JdC
UDgh2DlJAgMBAAECggEABLNz42yzLhITgbMxrXVdzKnCV0N0F7X0430ggU2UD3+Y
R9rtq3JOigyzneJGdF7hMnW7qsKzu3sSJ1sTG2Ak3ipYsOlqh+Mq2tStSRJ6vWbe
PmpsQ1+ev/TuPwFBO9W+w0V/dG6jBtSbFt3yucwtWPQaGIG1d1a2W2LggMxpVmyL
rvwiiUpA4LL0GjO5JzVHW7ZW5+ArfrEA+pwIMs4tJFlQxKJfUbgfhA/sG0/Ll59y
rCtmhNqlDB/SoBnxJJrX2CkTAoFhiOU2SCMTEWRd8Spz/vM1wjWLgMgocijrcjL5
PEzLQyt31p/RurVbEk6U0+3I5kbbmzF3vWbOmAMXAQKBgQD+vYg4wwIp5U74EEGZ
vN/dGSS4Nxs+XyrS1atOgx8cdK6RuRJb6uYSRedvcDCKJFIa4ZW4rKP/Rp8lR8xh
JeoxIC5rdCxAtknEH8zQV5ad6JjE/FGqAreJOzuDWl1PBzaFZGgKXI4VbtvixGGF
Rl0Q6TjTU9B1vYWCKa141Ql2qQKBgQDM58bXEP3JSKAh7P2GnEc5W+YjG2tufOEV
pvb+vUw7TxuJltYvrY/fuJUbRoUZvVUSzDE31oCqVlzUQm+Lp1Z1mcBlhJmMwJbh
C1M0TDCJagZBodUPeG0xdnJQce+0d8OOaSJt/XQ5y0V/zY4YqzvFuMSh6ClXME4C
0hAG0+RxoQKBgQDTcoFjFEN0gTmmYOAC+6safGdlXaCIijgin2c9mUs2tIe+v89E
atukaU/syUQRNorMc1ly3CKYn4c0S7+TGASn2F2PpfOhl23tlLPOcBW+ZzZ/tC0Z
IH42M+t3YYe4NHWGDczqZN8vXUC5n2aPWNOhWOVpTNXpFXJ/k5bBiJv9WQKBgEbP
ci+wd4OvzWbr91ElgJeZ4pYPS7kK/t30rTarRETaubF6ptojKK0vpJegby7N9zBf
0EJzplM3NS1FKDcixQYu9AYhJM83Xuy2dTKFgeB6+16DBpYqD9IgFLEoLqY3HSWB
v5wzEo9GZ+YaqxhrVGSnzYwGJwMydkMTROaXI0MBAoGBAKJipvInIfl7yJu5u5An
gChU+/u7k4gUJmqGvxfFUTG/otX4B7IED4BqD9FQIQOf5fEWLRGoyOCrJDhq2YCl
i4LljkZj8kW/70SM6aM5HZnoFB1Jb8LrOJYKKWHcl1oV4T9+W/SELZyFkJNb1jDY
C1mRwy9n8XbsKAIQQeA+wE0C
-----END PRIVATE KEY-----`;

