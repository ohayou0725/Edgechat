import { softDeleteMessage } from "./data/messages.js";
import { authorizeMessageModeration } from "./room-access.js";

export class MessageDeletionError extends Error {
	constructor(message) {
		super(message);
		this.name = "MessageDeletionError";
	}
}

async function defaultGetMessageMeta(db, channelId, messageId) {
	if (!db?.prepare) return null;
	try {
		const { results } = await db
			.prepare(
				`SELECT id, channel_id, sender_id, sender_kind, created_at, deleted_at
				 FROM messages
				 WHERE id = ? AND channel_id = ?
				 LIMIT 1`,
			)
			.bind(Number(messageId), Number(channelId))
			.all();
		return results[0] || null;
	} catch {
		return null;
	}
}

export function createMessageDeletion({
	authorize = authorizeMessageModeration,
	persistDeletion = softDeleteMessage,
	getMessageMeta = defaultGetMessageMeta,
} = {}) {
	return async function deleteRoomMessage(env, meta, payload) {
		const messageId = Number(payload.messageId);
		if (!Number.isInteger(messageId) || messageId <= 0) {
			throw new MessageDeletionError("消息不存在");
		}

		let action = "delete";
		const msg = await getMessageMeta(env.DB, meta.room.id, messageId);

		if (msg) {
			if (msg.deleted_at) {
				throw new MessageDeletionError("消息不存在或已被删除");
			}

			const isSender =
				msg.sender_kind === "local" &&
				Number(msg.sender_id) === Number(meta.principal?.userId);

			if (isSender) {
				action = "recall";
				const recallWindowSeconds = Number(env?.MESSAGE_RECALL_WINDOW_SECONDS || 120);
				const recallWindowMs = recallWindowSeconds * 1000;
				const createdAtStr = String(msg.created_at || "");
				const parsedDate = createdAtStr.endsWith("Z")
					? new Date(createdAtStr)
					: new Date(`${createdAtStr.replace(" ", "T")}Z`);
				const createdAtMs = parsedDate.getTime();
				const nowMs = Date.now();

				if (Number.isFinite(createdAtMs) && nowMs - createdAtMs > recallWindowMs) {
					throw new MessageDeletionError("已超过可撤回时间（2分钟）");
				}
			} else {
				const access = await authorize(
					env.DB,
					meta.principal,
					meta.room.kind,
					meta.room.id,
				);
				if (!access.ok) {
					throw new MessageDeletionError("无权删除该消息");
				}
			}
		} else {
			const access = await authorize(
				env.DB,
				meta.principal,
				meta.room.kind,
				meta.room.id,
			);
			if (!access.ok) {
				throw new MessageDeletionError("无权删除该消息");
			}
		}

		const deleted = await persistDeletion(env.DB, {
			channelId: meta.room.id,
			messageId,
		});
		if (!deleted) {
			throw new MessageDeletionError("消息不存在或已被删除");
		}

		return {
			messageId,
			packet: JSON.stringify({
				protocolVersion: 1,
				type: "message_deleted",
				action,
				messageId,
				operatorId: meta.principal?.userId,
				senderId: msg?.sender_id ?? undefined,
			}),
		};
	};
}

export const deleteRoomMessage = createMessageDeletion();
