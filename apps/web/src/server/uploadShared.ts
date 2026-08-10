import type { NextApiRequest } from "next";

import { createNextApiContext } from "@kan/api/trpc";
import { assertPermission } from "@kan/api/utils/permissions";
import {
  createCardWebhookPayload,
  sendWebhooksForWorkspace,
} from "@kan/api/utils/webhook";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as cardAttachmentRepo from "@kan/db/repository/cardAttachment.repo";

import { env } from "~/env";

/**
 * cachly: Shared plumbing for the chunked upload endpoints
 * (start / part / finish / abort / attach-draft).
 *
 * Why chunked at all: the single-shot /api/upload/attachment endpoint requires
 * a content-length header and caps bodies at 50MB, which is roughly 2-4 minutes
 * of screen recording. Screen recordings are produced as a stream, so they are
 * uploaded part by part *while the recording runs* — nothing is lost when the
 * tab dies, and the size cap is a configuration value instead of a hard wall.
 */

// S3 requires every part except the last to be at least 5MB. The client uses
// 6MB; anything noticeably larger is refused so a single request cannot pin
// an unbounded buffer in memory.
export const MAX_PART_BYTES = 16 * 1024 * 1024;

export const MAX_TOTAL_BYTES = env.ATTACHMENT_MAX_BYTES ?? 1024 * 1024 * 1024;

export const DRAFT_PREFIX = "_drafts";

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type CardTarget = NonNullable<
  Awaited<ReturnType<typeof cardRepo.getWorkspaceAndCardIdByCardPublicId>>
>;

type ApiContext = Awaited<ReturnType<typeof createNextApiContext>>;
type Database = ApiContext["db"];

export interface UploadTarget {
  userId: string;
  workspaceId: number;
  /** Present only when the upload targets an existing card. */
  card?: CardTarget;
}

export const getBucket = () => {
  const bucket = env.NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME;
  if (!bucket) throw new UploadError(500, "Attachments bucket not configured");
  return bucket;
};

/**
 * Resolves who is uploading and where they are allowed to write.
 *
 * Every request carries its own target (a card, or a board for drafts started
 * before the card exists) and is re-checked. Nothing is trusted from an
 * earlier call in the same upload — the uploadId and key travel through the
 * client, so they are treated as user input on every hop.
 */
export const resolveTarget = async (
  req: NextApiRequest,
  target: { cardPublicId?: string; boardPublicId?: string },
) => {
  const { user, db } = await createNextApiContext(req);
  if (!user) throw new UploadError(401, "Unauthorized");

  if (target.cardPublicId) {
    const card = await cardRepo.getWorkspaceAndCardIdByCardPublicId(
      db,
      target.cardPublicId,
    );
    if (!card) throw new UploadError(404, "Card not found");

    try {
      await assertPermission(db, user.id, card.workspaceId, "card:edit");
    } catch {
      throw new UploadError(403, "Permission denied");
    }

    return {
      db,
      target: { userId: user.id, workspaceId: card.workspaceId, card },
      user,
    };
  }

  if (target.boardPublicId) {
    const board = await boardRepo.getWorkspaceAndBoardIdByBoardPublicId(
      db,
      target.boardPublicId,
    );
    if (!board) throw new UploadError(404, "Board not found");

    try {
      await assertPermission(db, user.id, board.workspaceId, "card:edit");
    } catch {
      throw new UploadError(403, "Permission denied");
    }

    return {
      db,
      target: { userId: user.id, workspaceId: board.workspaceId },
      user,
    };
  }

  throw new UploadError(400, "Missing cardPublicId or boardPublicId");
};

/**
 * The key is generated server-side on start, but travels back through the
 * client for every part. This check is what stops a caller from pointing a
 * part upload at another workspace's prefix.
 */
export const assertKeyBelongsToTarget = (key: string, workspaceId: number) => {
  if (typeof key !== "string" || !key.startsWith(`${workspaceId}/`)) {
    throw new UploadError(403, "Key does not belong to this workspace");
  }
  // Path traversal would let a key escape the workspace prefix after
  // normalisation on the storage side.
  if (key.includes("..")) throw new UploadError(400, "Invalid key");
};

export const sanitizeFilename = (raw: string) =>
  raw.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 200) || "datei";

export const decodeHeaderValue = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const readJsonBody = async (req: NextApiRequest): Promise<unknown> => {
  // The chunked endpoints disable the body parser so `part` can stream; the
  // JSON-shaped siblings therefore have to read their own body.
  if (req.body && typeof req.body === "object") return req.body;

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > 1024 * 1024) throw new UploadError(413, "Body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UploadError(400, "Invalid JSON body");
  }
};

/**
 * Creates the attachment row, the activity entry and the webhook event.
 *
 * This mirrors what /api/upload/attachment does after its single-shot upload.
 * The webhook matters beyond the UI: mothership-transcribe listens for
 * `card.attachment.added` and turns audio/video into a transcript comment.
 */
export const createAttachmentRecord = async (
  db: Database,
  args: {
    card: CardTarget;
    cardPublicId: string;
    userId: string;
    userName: string | null;
    s3Key: string;
    filename: string;
    originalFilename: string;
    contentType: string;
    size: number;
  },
) => {
  const attachment = await cardAttachmentRepo.create(db, {
    cardId: args.card.id,
    filename: args.filename,
    originalFilename: args.originalFilename,
    contentType: args.contentType,
    size: args.size,
    s3Key: args.s3Key,
    createdBy: args.userId,
  });

  if (!attachment) throw new UploadError(500, "Failed to create attachment");

  await cardActivityRepo.create(db, {
    type: "card.updated.attachment.added",
    cardId: args.card.id,
    attachmentId: attachment.id,
    toTitle: args.originalFilename,
    createdBy: args.userId,
  });

  sendWebhooksForWorkspace(
    db,
    args.card.workspaceId,
    createCardWebhookPayload(
      "card.attachment.added",
      {
        id: String(args.card.id),
        publicId: args.cardPublicId,
        title: args.card.title,
        listId: args.card.listPublicId,
      },
      {
        boardId: args.card.boardPublicId,
        boardName: args.card.boardName,
        listName: args.card.listName,
        user: { id: args.userId, name: args.userName },
        changes: {
          attachment: { from: null, to: args.originalFilename },
        },
      },
    ),
  ).catch((error: unknown) => {
    console.error("Failed to send card.attachment.added webhooks:", error);
  });

  return attachment;
};

export const readBinaryBody = async (
  req: NextApiRequest,
  limit: number,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limit) throw new UploadError(413, "Part too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
};
