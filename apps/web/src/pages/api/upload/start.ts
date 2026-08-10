import type { NextApiRequest, NextApiResponse } from "next";
import { CreateMultipartUploadCommand } from "@aws-sdk/client-s3";

import { withApiLogging } from "@kan/api/utils/apiLogging";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import { createS3Client, generateUID } from "@kan/shared/utils";

import {
  DRAFT_PREFIX,
  failRequest,
  getBucket,
  readJsonBody,
  resolveTarget,
  sanitizeFilename,
  UploadError,
} from "~/server/uploadShared";

export const config = { api: { bodyParser: false } };

/**
 * cachly: Opens a chunked upload. Returns the storage key and the S3 upload id;
 * both travel back with every part and are re-authorised on each call.
 */
export default withRateLimit(
  { points: 100, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return failRequest(req, res, 405, "Method not allowed");
    }

    try {
      const body = (await readJsonBody(req)) as {
        filename?: string;
        contentType?: string;
        cardPublicId?: string;
        boardPublicId?: string;
      };

      const { target } = await resolveTarget(req, {
        cardPublicId: body.cardPublicId,
        boardPublicId: body.boardPublicId,
      });

      const originalFilename = body.filename ?? "aufnahme.webm";
      const filename = sanitizeFilename(originalFilename);
      const contentType = body.contentType ?? "application/octet-stream";

      // A draft upload has no card yet, so it lives under a workspace-scoped
      // drafts prefix until /api/upload/attach-draft binds it to a card.
      const folder = body.cardPublicId ?? DRAFT_PREFIX;
      const key = `${target.workspaceId}/${folder}/${generateUID()}-${filename}`;

      const client = createS3Client();
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: getBucket(),
          Key: key,
          ContentType: contentType,
        }),
      );

      if (!created.UploadId) {
        return failRequest(
          req,
          res,
          500,
          "Storage did not return an upload id",
        );
      }

      return res.status(200).json({
        key,
        uploadId: created.UploadId,
        filename,
        originalFilename,
        contentType,
      });
    } catch (error) {
      if (error instanceof UploadError) {
        return failRequest(req, res, error.status, error.message);
      }
      console.error("chunked upload start failed:", error);
      return failRequest(req, res, 500, "Internal server error");
    }
  }),
);
