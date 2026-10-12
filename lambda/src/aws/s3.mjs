import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BOUNDED } from './bounded.mjs';

// followRegionRedirects: the bucket of a list may be in another region than the router.
export function createS3(client = new S3Client({ followRegionRedirects: true, requestHandler: BOUNDED })) {
  return {
    getObject: async ({ bucket, key, signal }) => (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal })).Body,
    // A conditional GET (the manager's lists, R6b): the object and its ETag, or { notModified: true } while it is the one
    // the caller holds (S3 answers 304, which the SDK throws).
    getObjectIf: async ({ bucket, key, etag, signal }) => {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, ...(etag ? { IfNoneMatch: etag } : {}) }), { abortSignal: signal ?? AbortSignal.timeout(10_000) });
        return { body: Buffer.from(await out.Body.transformToByteArray()), etag: out.ETag };
      } catch (err) {
        if (err.name === 'NotModified' || err.$metadata?.httpStatusCode === 304) return { notModified: true };
        throw err;
      }
    },
    // The manager's list function: its bucket's objects.
    putObject: async ({ bucket, key, body, contentType }) => client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })),
    deleteObject: async ({ bucket, key }) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
  };
}
