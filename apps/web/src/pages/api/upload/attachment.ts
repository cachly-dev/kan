import type { NextApiRequest, NextApiResponse } from "next";
import { Upload } from "@aws-sdk/lib-storage";

import { createNextApiContext } from "@kan/api/trpc";
import { withApiLogging } from "@kan/api/utils/apiLogging";
import { assertPermission } from "@kan/api/utils/permissions";
import { withRateLimit } from "@kan/api/utils/rateLimit";
import {
  createCardWebhookPayload,
  sendWebhooksForWorkspace,
} from "@kan/api/utils/webhook";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as cardAttachmentRepo from "@kan/db/repository/cardAttachment.repo";
import { createS3Client, generateUID } from "@kan/shared/utils";

import { env } from "~/env";
import { failRequest } from "~/server/uploadShared";

// cachly: Every early exit here drains the request body first (failRequest).
// Without that, an aborted upload leaves its bytes in the socket and keep-alive
// prepends them to the NEXT upload — that is how a screen recording ended up
// with 16438 bytes of junk before its EBML header on 2026-08-10.
// FIXME: Respect the environment variable: NEXT_API_BODY_SIZE_LIMIT
const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

export const config = {
  api: {
    bodyParser: false,
  },
};

export default withRateLimit(
  { points: 100, duration: 60 },
  withApiLogging(async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return failRequest(req, res, 405, "Method not allowed");
    }

    try {
      const { user, db } = await createNextApiContext(req);

      if (!user) {
        return failRequest(req, res, 401, "Unauthorized");
      }

      const bucket = env.NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME;
      if (!bucket) {
        return failRequest(req, res, 500, "Attachments bucket not configured");
      }

      const cardPublicId = req.query.cardPublicId;
      if (typeof cardPublicId !== "string" || cardPublicId.length < 12) {
        return failRequest(req, res, 400, "Invalid cardPublicId");
      }

      const contentType = req.headers["content-type"];
      const contentLengthHeader = req.headers["content-length"];
      const contentLength = contentLengthHeader
        ? Number.parseInt(contentLengthHeader, 10)
        : NaN;

      if (typeof contentType !== "string") {
        return failRequest(req, res, 400, "Missing content type");
      }

      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        return failRequest(req, res, 400, "Missing or invalid content length");
      }

      if (contentLength > MAX_SIZE_BYTES) {
        return failRequest(req, res, 400, "File too large");
      }

      const rawFilenameHeader =
        (req.headers["x-original-filename"] as string | undefined) ?? "file";
      const originalFilenameHeader = (() => {
        try {
          return decodeURIComponent(rawFilenameHeader);
        } catch {
          return rawFilenameHeader;
        }
      })();

      const sanitizedFilename = originalFilenameHeader
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .substring(0, 200);

      // Get card and check permissions
      const card = await cardRepo.getWorkspaceAndCardIdByCardPublicId(
        db,
        cardPublicId,
      );

      if (!card) {
        return failRequest(req, res, 404, "Card not found");
      }

      // Check if user has permission to edit the card
      try {
        await assertPermission(db, user.id, card.workspaceId, "card:edit");
      } catch {
        return failRequest(req, res, 403, "Permission denied");
      }

      const s3Key = `${card.workspaceId}/${cardPublicId}/${generateUID()}-${sanitizedFilename}`;

      const client = createS3Client();

      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: s3Key,
          Body: req,
          ContentType: contentType,
          ContentLength: contentLength,
        },
        leavePartsOnError: false,
      });

      await upload.done();

      // Create attachment record and log activity
      const attachment = await cardAttachmentRepo.create(db, {
        cardId: card.id,
        filename: sanitizedFilename,
        originalFilename: originalFilenameHeader,
        contentType,
        size: contentLength,
        s3Key,
        createdBy: user.id,
      });

      if (!attachment) {
        return failRequest(req, res, 500, "Failed to create attachment");
      }

      await cardActivityRepo.create(db, {
        type: "card.updated.attachment.added",
        cardId: card.id,
        attachmentId: attachment.id,
        toTitle: originalFilenameHeader,
        createdBy: user.id,
      });

      // cachly: Webhook-Paritaet mit dem tRPC-confirm-Pfad — dieser Endpoint
      // ist der Weg der Web-UI; ohne das Event sieht der Mothership-
      // Transkriptions-Worker keine UI-Uploads. (non-blocking)
      sendWebhooksForWorkspace(
        db,
        card.workspaceId,
        createCardWebhookPayload(
          "card.attachment.added",
          {
            id: String(card.id),
            publicId: cardPublicId,
            title: card.title,
            listId: card.listPublicId,
          },
          {
            boardId: card.boardPublicId,
            boardName: card.boardName,
            listName: card.listName,
            user: { id: user.id, name: user.name },
            changes: {
              attachment: { from: null, to: originalFilenameHeader },
            },
          },
        ),
      ).catch((error: unknown) => {
        console.error("Failed to send card.attachment.added webhooks:", error);
      });

      return res.status(200).json({ attachment });
    } catch (error) {
      return failRequest(req, res, 500, "Internal server error");
    }
  }),
);
