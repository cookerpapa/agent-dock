import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decryptBackup, encryptBackup, sha256File } from "./production-backup-common.mjs";

const directory = await mkdtemp(join(tmpdir(), "pi-cloud-backup-crypto-"));
try {
  const input = join(directory, "payload.tar.gz");
  const encrypted = join(directory, "payload.adbackup");
  const decrypted = join(directory, "payload.restored.tar.gz");
  const tampered = join(directory, "payload.tampered.adbackup");
  const payload = randomBytes(1_048_611);
  const passphrase = randomBytes(48).toString("base64url");
  await writeFile(input, payload, { mode: 0o600 });
  await encryptBackup(input, encrypted, passphrase);
  await decryptBackup(encrypted, decrypted, passphrase);
  assert.equal(await sha256File(decrypted), await sha256File(input));
  assert.deepEqual(await readFile(decrypted), payload);

  await copyFile(encrypted, tampered);
  const handle = await open(tampered, "r+");
  try {
    const metadata = await handle.stat();
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, metadata.size - 17);
    byte[0] ^= 0xff;
    await handle.write(byte, 0, 1, metadata.size - 17);
  } finally {
    await handle.close();
  }
  await assert.rejects(
    decryptBackup(tampered, join(directory, "tampered-output"), passphrase),
    /authentication failed/,
  );
  await assert.rejects(
    decryptBackup(encrypted, join(directory, "wrong-key-output"), `${passphrase}-wrong`),
    /authentication failed/,
  );
  process.stdout.write(
    `${JSON.stringify({ backupCryptoCheck: "passed", bytes: payload.byteLength, tamperRejected: true, wrongKeyRejected: true })}\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
