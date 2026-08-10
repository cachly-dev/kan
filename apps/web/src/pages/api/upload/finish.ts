import type { NextApiRequest, NextApiResponse } from "next";
import { CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";

import { withApiLogging } from "@kan/api/utils/apiLogging";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import { createS3Client } from "@kan/shared/utils";

import {
  assertKeyBelongsToTarget,
  createAttachmentRecord,
  failRequest,
  getBucket,
  MAX_TOTAL_BYTES,
  readJsonBody,
  resolveTarget,
  sanitizeFilename,
  UploadError,
} from "~/server/uploadShared";

export const config = { api: { bodyParser: false } };

interface FinishBody {
  key?: string;
  uploadId?: string;
  parts?: { partNumber?: number; etag?: string }[];
  size?: number;
  contentType?: string;
  originalFilename?: string;
  cardPublicId?: string;
  boardPublicId?: string;
}

/**
 * cachly: Seals a chunked upload. With a card it also creates the attachment
 * row; without one (a draft recorded before the card existed) it only returns
 * the storage key, which /api/upload/attach-draft later binds to the new card.
 */
export default withRateLimit(
  { points: 100, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return failRequest(req, res, 405, "Method not allowed");
    }

    try {
      const body = (await readJsonBody(req)) as FinishBody;
      const { key, uploadId, parts, cardPublicId, boardPublicId } = body;

      if (typeof key !== "string" || typeof uploadId !== "string") {
        return failRequest(req, res, 400, "Missing key or uploadId");
      }
      if (!Array.isArray(parts) || parts.length === 0) {
        return failRequest(req, res, 400, "No parts to complete");
      }

      const size = Number(body.size);
      if (!Number.isFinite(size) || size <= 0) {
        return failRequest(req, res, 400, "Invalid size");
      }
      if (size > MAX_TOTAL_BYTES) {
        return failRequest(req, res, 413, "Upload exceeds the size limit");
      }

      const { db, target, user } = await resolveTarget(req, {
        cardPublicId,
        boardPublicId,
      });
      assertKeyBelongsToTarget(key, target.workspaceId);

      const completedParts = parts
        .map((part) => ({
          PartNumber: Number(part.partNumber),
          ETag: part.etag,
        }))
        .filter(
          (part): part is { PartNumber: number; ETag: string } =>
            Number.isInteger(part.PartNumber) && typeof part.ETag === "string",
        )
        .sort((a, b) => a.PartNumber - b.PartNumber);

      if (completedParts.length !== parts.length) {
        return failRequest(req, res, 400, "Invalid part list");
      }

      const client = createS3Client();
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: getBucket(),
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: completedParts },
        }),
      );

      const originalFilename = body.originalFilename ?? "aufnahme.webm";
      const contentType = body.contentType ?? "application/octet-stream";

      if (!target.card) {
        // Draft: the object exists, the card does not. Nothing to link yet.
        return res.status(200).json({
          key,
          draft: true,
          originalFilename,
          contentType,
          size,
        });
      }

      const attachment = await createAttachmentRecord(db, {
        card: target.card,
        cardPublicId: cardPublicId ?? "",
        userId: target.userId,
        userName: user.name,
        s3Key: key,
        filename: sanitizeFilename(originalFilename),
        originalFilename,
        contentType,
        size,
      });

      return res.status(200).json({ attachment, key });
    } catch (error) {
      if (error instanceof UploadError) {
        return failRequest(req, res, error.status, error.message);
      }
      console.error("chunked upload finish failed:", error);
      return failRequest(req, res, 500, "Internal server error");
    }
  }),
);
