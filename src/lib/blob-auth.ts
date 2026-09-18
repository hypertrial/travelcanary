export type BlobAuth = { token?: string; storeId?: string };
export type BlobAuthInput = string | BlobAuth;

export function resolveBlobAuth(input: BlobAuthInput): BlobAuth {
  const auth = typeof input === "string" ? { token: input.trim() } : {
    token: input.token?.trim(), storeId: input.storeId?.trim(),
  };
  if (auth.storeId) return { storeId: auth.storeId };
  if (auth.token) return { token: auth.token };
  throw new Error("Blob credentials are not configured");
}
