import type { NextApiRequest, NextApiResponse } from "next";
import { AbortMultipartUploadCommand } from "@aws-sdk/client-s3";

import { withApiLogging } from "@kan/api/utils/apiLogging";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import { createS3Client } from "@kan/shared/utils";

import {
  assertKeyBelongsToTarget,
  failRequest,
  getBucket,
  readJsonBody,
  resolveTarget,
  UploadError,
} from "~/server/uploadShared";

export const config = { api: { bodyParser: false } };

/**
 * cachly: Discards a chunked upload so storage does not keep orphaned parts
 * when a recording is cancelled.
 */
export default withRateLimit(
  { points: 100, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return failRequest(req, res, 405, "Method not allowed");
    }

    try {
      const body = (await readJsonBody(req)) as {
        key?: string;
        uploadId?: string;
        cardPublicId?: string;
        boardPublicId?: string;
      };

      if (typeof body.key !== "string" || typeof body.uploadId !== "string") {
        return failRequest(req, res, 400, "Missing key or uploadId");
      }

      const { target } = await resolveTarget(req, {
        cardPublicId: body.cardPublicId,
        boardPublicId: body.boardPublicId,
      });
      assertKeyBelongsToTarget(body.key, target.workspaceId);

      const client = createS3Client();
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: getBucket(),
          Key: body.key,
          UploadId: body.uploadId,
        }),
      );

      return res.status(200).json({ aborted: true });
    } catch (error) {
      if (error instanceof UploadError) {
        return failRequest(req, res, error.status, error.message);
      }
      console.error("chunked upload abort failed:", error);
      return failRequest(req, res, 500, "Internal server error");
    }
  }),
);
