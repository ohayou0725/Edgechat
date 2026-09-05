import { updateMessageContent, getMessageById } from "./data/messages.js";

export class MessageEditingError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.name = "MessageEditingError";
		this.status = status;
	}
}

async function defaultGetMessage(env, messageId) {
	return getMessageById(env, messageId);
}

export function createMessageEditing({
	getMessage = defaultGetMessage,
	updateContent = updateMessageContent,
} = {}) {
	return async function editRoomMessage(env, meta, payload) {
		const messageId = Number(payload.messageId);
		if (!Number.isInteger(messageId) || messageId <= 0) {
			throw new MessageEditingError("消息不存在", 400);
		}

		const cleanContent = String(payload.content || "").trim();
		if (!cleanContent) {
			throw new MessageEditingError("消息内容不能为空", 400);
		}

		if (cleanContent.length > 10000) {
			throw new MessageEditingError("消息内容过长", 400);
		}

		const existing = await getMessage(env, messageId);
		if (!existing) {
			throw new MessageEditingError("消息不存在或已被删除", 404);
		}

		// 权限校验：只能编辑自己发出的本地消息
		const currentUserId = Number(meta.principal?.userId);
		if (
			existing.sender?.kind !== "local" ||
			Number(existing.sender?.id) !== currentUserId
		) {
			throw new MessageEditingError("无权编辑该消息", 403);
		}

		const updatedMessage = await updateContent(env, {
			channelId: meta.room.id,
			messageId,
			senderId: currentUserId,
			content: cleanContent,
		});

		if (!updatedMessage) {
			throw new MessageEditingError("消息编辑失败或已被删除", 400);
		}

		return {
			message: updatedMessage,
			packet: JSON.stringify({
				protocolVersion: 1,
				type: "message_updated",
				message: updatedMessage,
			}),
		};
	};
}

export const editRoomMessage = createMessageEditing();
