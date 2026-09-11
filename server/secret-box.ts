import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets kept in PostgreSQL, keyed by TOKEN_ENCRYPTION_KEY.
 * The associated data binds each value to its row and purpose, so a sealed
 * value copied to another row or column fails to open.
 */
export class SecretBox {
  private readonly key?: Buffer;
  constructor(key = process.env.TOKEN_ENCRYPTION_KEY || "") {
    if (key && !/^[a-f\d]{64}$/i.test(key))
      throw new Error(
        "TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.",
      );
    if (key) this.key = Buffer.from(key, "hex");
  }
  get configured(): boolean {
    return Boolean(this.key);
  }
  seal(value: string, context: string): string {
    if (!this.key) throw new Error("Secret storage is not configured.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), bytes]
      .map((part) => part.toString("base64url"))
      .join(".");
  }
  open(sealed: string, context: string): string {
    if (!this.key) throw new Error("Secret storage is not configured.");
    const [iv, tag, data] = sealed
      .split(".")
      .map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  }
}
