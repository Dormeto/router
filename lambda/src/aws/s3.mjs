import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

// followRegionRedirects: the bucket of a list may be in another region than the router.
export function createS3(client = new S3Client({ followRegionRedirects: true })) {
  return {
    getObject: async ({ bucket, key, signal }) => (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal })).Body,
  };
}
