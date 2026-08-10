import type { NextApiRequest, NextApiResponse } from "next";
import { HeadObjectCommand } from "@aws-sdk/client-s3";

import { withApiLogging } from "@kan/api/utils/apiLogging";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import { createS3Client } from "@kan/shared/utils";

import {
  assertKeyBelongsToTarget,
  createAttachmentRecord,
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
 * cachly: Binds an already uploaded draft object to a freshly created card.
 *
 * This is what makes "record while you are still typing the card" work: the
 * recording streams to storage during the take, and creating the card is a
 * single small call instead of a long upload the user has to sit through.
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
        cardPublicId?: string;
        originalFilename?: string;
        contentType?: string;
      };

      if (
        typeof body.key !== "string" ||
        typeof body.cardPublicId !== "string"
      ) {
        return failRequest(req, res, 400, "Missing key or cardPublicId");
      }

      const { db, target, user } = await resolveTarget(req, {
        cardPublicId: body.cardPublicId,
      });
      assertKeyBelongsToTarget(body.key, target.workspaceId);

      if (!body.key.startsWith(`${target.workspaceId}/${DRAFT_PREFIX}/`)) {
        return failRequest(req, res, 400, "Not a draft key");
      }
      if (!target.card) {
        return failRequest(req, res, 404, "Card not found");
      }

      // The object has to exist before a row claims it, otherwise the card
      // shows an attachment that can never be played.
      const client = createS3Client();
      const head = await client.send(
        new HeadObjectCommand({ Bucket: getBucket(), Key: body.key }),
      );

      const originalFilename = body.originalFilename ?? "aufnahme.webm";
      const attachment = await createAttachmentRecord(db, {
        card: target.card,
        cardPublicId: body.cardPublicId,
        userId: target.userId,
        userName: user.name,
        s3Key: body.key,
        filename: sanitizeFilename(originalFilename),
        originalFilename,
        contentType:
          body.contentType ?? head.ContentType ?? "application/octet-stream",
        size: head.ContentLength ?? 0,
      });

      return res.status(200).json({ attachment });
    } catch (error) {
      if (error instanceof UploadError) {
        return failRequest(req, res, error.status, error.message);
      }
      console.error("attach-draft failed:", error);
      return failRequest(req, res, 500, "Internal server error");
    }
  }),
);
