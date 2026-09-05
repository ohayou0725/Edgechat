import { activeUserSql } from "../user-status.js";

async function resolveReadableMessageId(db, channelId, messageId = null) {
	const filters = ["channel_id = ?", "deleted_at IS NULL"];
	const binds = [Number(channelId)];
	if (messageId !== null && messageId !== undefined) {
		filters.push("id <= ?");
		binds.push(Number(messageId));
	}
	const { results } = await db
		.prepare(`SELECT COALESCE(MAX(id), 0) AS message_id FROM messages WHERE ${filters.join(" AND ")}`)
		.bind(...binds)
		.all();
	return Number(results[0]?.message_id || 0);
}

export async function markRoomRead(db, { channelId, userId, messageId = null }) {
	const lastReadMessageId = await resolveReadableMessageId(db, channelId, messageId);
	await db
		.prepare(
			`INSERT INTO message_reads (channel_id, user_id, last_read_message_id, updated_at)
			 VALUES (?, ?, ?, CURRENT_TIMESTAMP)
			 ON CONFLICT(channel_id, user_id) DO UPDATE
			 SET last_read_message_id = MAX(message_reads.last_read_message_id, excluded.last_read_message_id),
			     updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(Number(channelId), Number(userId), lastReadMessageId)
		.run();
	return lastReadMessageId;
}

export async function getPeerLastReadMessageId(db, { channelId, myUserId }) {
	const { results } = await db
		.prepare(
			`SELECT mr.last_read_message_id
			 FROM channels c
			 JOIN channel_members cm ON cm.channel_id = c.id
			 LEFT JOIN message_reads mr ON mr.channel_id = cm.channel_id AND mr.user_id = cm.user_id
			 WHERE c.id = ? AND c.kind = 'dm' AND cm.user_id != ?
			 ORDER BY mr.last_read_message_id DESC
			 LIMIT 1`,
		)
		.bind(Number(channelId), Number(myUserId))
		.all();
	return Number(results[0]?.last_read_message_id || 0);
}

export async function getUserLastReadMessageId(db, { channelId, userId }) {
	const { results } = await db
		.prepare(
			`SELECT last_read_message_id
			 FROM message_reads
			 WHERE channel_id = ? AND user_id = ?
			 LIMIT 1`,
		)
		.bind(Number(channelId), Number(userId))
		.all();
	return Number(results[0]?.last_read_message_id || 0);
}

export async function countUnreadMessages(db, { channelId, userId }) {
	const { results } = await db
		.prepare(
				`SELECT COUNT(*) AS unread_count FROM messages m
				 WHERE m.channel_id = ? AND m.deleted_at IS NULL
				   AND (m.sender_id IS NULL OR m.sender_id != ?)
			   AND m.id > COALESCE((SELECT mr.last_read_message_id FROM message_reads mr
			                            WHERE mr.channel_id = ? AND mr.user_id = ?), 0)`,
		)
		.bind(Number(channelId), Number(userId), Number(channelId), Number(userId))
		.all();
	return Number(results[0]?.unread_count || 0);
}

export async function countUnreadMentions(db, { channelId, userId }) {
	const { results } = await db
		.prepare(
			`SELECT COUNT(*) AS unread_count
			 FROM messages m
			 WHERE m.channel_id = ?
			   AND m.deleted_at IS NULL
			   AND m.id > COALESCE((SELECT mr.last_read_message_id
			                            FROM message_reads mr
			                            WHERE mr.channel_id = ? AND mr.user_id = ?), 0)
			   AND EXISTS (
			     SELECT 1
			     FROM json_each(COALESCE(m.mention_user_ids, '[]')) mention_ids
			     WHERE CAST(mention_ids.value AS INTEGER) = ?
			   )`,
		)
		.bind(Number(channelId), Number(channelId), Number(userId), Number(userId))
		.all();
	return Number(results[0]?.unread_count || 0);
}

export async function listRoomMemberIds(db, channelId) {
	const { results } = await db
		.prepare(
			`SELECT cm.user_id
			 FROM channel_members cm
			 JOIN users u ON u.id = cm.user_id
			 WHERE cm.channel_id = ?
			   AND u.deleted_at IS NULL
			   AND ${activeUserSql("u")}`,
		)
		.bind(Number(channelId))
		.all();
	return results
		.map((row) => Number(row.user_id))
		.filter((userId) => Number.isFinite(userId));
}
