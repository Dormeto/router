// The manager's list function (vision docs/specs/2026-10-08-reliability-security-design.md, R6b), deployed by the manager
// from the router bundle and run hourly: the lists of its catalog downloaded, checked and published to its bucket.
import { createS3 } from './aws/s3.mjs';
import { createListPublisher } from './lib/list-publish.mjs';
import { downloadText } from './lib/list-refresh.mjs';
import { logger } from './lib/log.mjs';

const s3 = createS3();
const publisher = createListPublisher({
  s3,
  bucket: process.env.DMT_LISTS_BUCKET,
  // Sources given as s3:// URIs are read with the S3 API (the function's role may read them).
  download: (url) => downloadText(url, { getObject: s3.getObject }),
  log: logger,
});

export const handler = async () => publisher.run();
