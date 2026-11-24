export interface UploadInput {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType: string;
  /** Cancels the request in flight; a caller racing a timeout instead would let the write still land. */
  abortSignal?: AbortSignal;
}

export interface UploadStreamInput {
  bucket: string;
  key: string;
  body: AsyncIterable<Uint8Array>;
  contentType: string;
  maxBytes: number;
  abortSignal?: AbortSignal;
}

export interface DownloadInput {
  bucket: string;
  key: string;
  startByte?: number;
  endByte?: number;
  abortSignal?: AbortSignal;
}

export interface CopyInput {
  sourceBucket: string;
  sourceKey: string;
  destinationBucket: string;
  destinationKey: string;
}

export interface PresignedUrlInput {
  bucket: string;
  key: string;
  expiresInSeconds: number;
  responseContentDisposition?: string;
}

export interface PresignedUrlsInput {
  bucket: string;
  keys: string[];
  expiresInSeconds: number;
  signingDate?: Date;
}

export interface PresignedUploadUrlInput {
  bucket: string;
  key: string;
  expiresInSeconds: number;
  contentType: string;
  cacheControl?: string;
  contentLength?: number;
}

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date | null;
  etag: string | null;
}

export interface DeleteInput {
  bucket: string;
  key: string;
}

export interface ObjectPrefixInput {
  bucket: string;
  prefix: string;
}

export interface ObjectStore {
  upload(input: UploadInput): Promise<void>;
  /** Streams in 5MB parts, so memory grows with the part size, not the file size. */
  uploadStream(input: UploadStreamInput): Promise<number | null>;
  download(input: DownloadInput): Promise<Uint8Array>;
  downloadStream(input: DownloadInput): Promise<ReadableStream<Uint8Array>>;
  copy(input: CopyInput): Promise<void>;
  getPresignedUrl(input: PresignedUrlInput): Promise<string>;
  getPresignedUrls(input: PresignedUrlsInput): Promise<string[]>;
  getPresignedUploadUrl(input: PresignedUploadUrlInput): Promise<string>;
  list(input: ObjectPrefixInput): Promise<StoredObject[]>;
  size(input: DeleteInput): Promise<number | null>;
  delete(input: DeleteInput): Promise<void>;
  deletePrefix(input: ObjectPrefixInput & { keep?: ReadonlySet<string> }): Promise<number>;
}
