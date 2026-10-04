import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { currentCloudflareBindings, isCloudflareRuntime } from "@palladium/service-kit";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { MAX_UPLOAD_BYTES } from "./uploads.js";

type StoredObject = { size: number; arrayBuffer(): Promise<ArrayBuffer> };
export interface PrivateUploadsBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}
export interface ResourceStorage {
  put(businessId: string, storageKey: string, bytes: Buffer, mimeType: string): Promise<void>;
  read(businessId: string, storageKey: string): Promise<Buffer | Readable>;
  delete(businessId: string, storageKey: string): Promise<void>;
}
/** Both key parts are validated before filesystem or R2 access. Bucket contents never become public. */
export function resourceKey(businessId: string, storageKey: string) {
  const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  if (!uuid.test(businessId) || !uuid.test(storageKey)) throw new Error("Invalid private resource key");
  return `${businessId}/${storageKey}`;
}
export class R2ResourceStorage implements ResourceStorage {
  constructor(private readonly bucket: PrivateUploadsBucket) {}
  async put(businessId: string, storageKey: string, bytes: Buffer, mimeType: string) {
    await this.bucket.put(resourceKey(businessId, storageKey), bytes, { httpMetadata: { contentType: mimeType } });
  }
  async read(businessId: string, storageKey: string) {
    const object = await this.bucket.get(resourceKey(businessId, storageKey));
    if (!object) throw new NotFoundException("Resource file is unavailable");
    if (object.size > MAX_UPLOAD_BYTES) throw new ServiceUnavailableException("Stored resource exceeds upload limit");
    const bytes = Buffer.from(await object.arrayBuffer());
    if (bytes.length > MAX_UPLOAD_BYTES || bytes.length !== object.size) throw new ServiceUnavailableException("Stored resource size is invalid");
    return bytes;
  }
  async delete(businessId: string, storageKey: string) { await this.bucket.delete(resourceKey(businessId, storageKey)); }
}
export class DiskResourceStorage implements ResourceStorage {
  constructor(private readonly directory = resolve(process.env.UPLOAD_DIRECTORY || ".local/uploads")) {}
  private paths(businessId: string, storageKey: string) {
    resourceKey(businessId, storageKey);
    const directory = join(this.directory, businessId);
    return { directory, finalPath: join(directory, storageKey), temporaryPath: join(directory, `.${storageKey}.tmp`) };
  }
  async put(businessId: string, storageKey: string, bytes: Buffer) {
    const { directory, finalPath, temporaryPath } = this.paths(businessId, storageKey);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temporaryPath, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporaryPath, finalPath);
  }
  async read(businessId: string, storageKey: string) {
    try { return (await open(this.paths(businessId, storageKey).finalPath, "r")).createReadStream(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NotFoundException("Resource file is unavailable");
      throw error;
    }
  }
  async delete(businessId: string, storageKey: string) {
    const { temporaryPath, finalPath } = this.paths(businessId, storageKey);
    // Missing files are already removed; every other cleanup failure remains visible.
    await Promise.all([temporaryPath, finalPath].map(async path => {
      try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }));
  }
}
export function resourceStorage(): ResourceStorage {
  if (!isCloudflareRuntime()) return new DiskResourceStorage();
  const bucket = currentCloudflareBindings()?.UPLOADS as PrivateUploadsBucket | undefined;
  if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function" || typeof bucket.delete !== "function")
    throw new ServiceUnavailableException("Private upload storage is not configured");
  return new R2ResourceStorage(bucket);
}
