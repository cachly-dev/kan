import type { NextApiRequest, NextApiResponse } from "next";
import { UploadPartCommand } from "@aws-sdk/client-s3";

import { withApiLogging } from "@kan/api/utils/apiLogging";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import { createS3Client } from "@kan/shared/utils";

import {
  assertKeyBelongsToTarget,
  getBucket,
  MAX_PART_BYTES,
  readBinaryBody,
  resolveTarget,
  UploadError,
} from "~/server/uploadShared";

export const config = { api: { bodyParser: false } };

/**
 * cachly: Uploads one part of a chunked upload and hands the ETag back to the
 * browser, which collects them for the finish call. Keeping the ETags in the
 * client is what makes this endpoint stateless — no session table, no
 * in-memory map that a container restart would wipe.
 *
 * A 6MB part is small enough to pass every proxy in front of this app, so
 * long recordings no longer depend on a single huge request surviving.
 */
export default withRateLimit(
  { points: 600, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "PUT" && req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const key = req.query.key;
      const uploadId = req.query.uploadId;
      const partNumber = Number.parseInt(String(req.query.partNumber), 10);
      const cardPublicId = req.query.cardPublicId;
      const boardPublicId = req.query.boardPublicId;

      if (typeof key !== "string" || typeof uploadId !== "string") {
        return res.status(400).json({ error: "Missing key or uploadId" });
      }
      if (
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > 10000
      ) {
        return res.status(400).json({ error: "Invalid part number" });
      }

      const { target } = await resolveTarget(req, {
        cardPublicId:
          typeof cardPublicId === "string" ? cardPublicId : undefined,
        boardPublicId:
          typeof boardPublicId === "string" ? boardPublicId : undefined,
      });
      assertKeyBelongsToTarget(key, target.workspaceId);

      const body = await readBinaryBody(req, MAX_PART_BYTES);
      if (body.length === 0) {
        return res.status(400).json({ error: "Empty part" });
      }

      const client = createS3Client();
      const uploaded = await client.send(
        new UploadPartCommand({
          Bucket: getBucket(),
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
          ContentLength: body.length,
        }),
      );

      return res.status(200).json({ partNumber, etag: uploaded.ETag });
    } catch (error) {
      if (error instanceof UploadError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("chunked upload part failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }),
);
