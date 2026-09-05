import assert from "node:assert/strict";
import test from "node:test";

import { listMessages } from "../worker/src/data/messages.js";
import {
	getPeerLastReadMessageId,
	getUserLastReadMessageId,
} from "../worker/src/data/unread.js";
import { broadcastRoomReadReceipt } from "../worker/src/do-bridge.js";
import { ChannelRoom } from "../worker/src/do/ChannelRoom.js";

function createMockDb(handlers = {}) {
	const queries = [];
	return {
		queries,
		prepare(sql) {
			return {
				bind(...binds) {
					this._binds = binds;
					return this;
				},
				async first(col) {
					queries.push({ sql, binds: this._binds || [] });
					if (handlers.first) {
						return handlers.first(sql, this._binds || [], col);
					}
					return null;
				},
				async all() {
					queries.push({ sql, binds: this._binds || [] });
					if (handlers.all) {
						return handlers.all(sql, this._binds || []);
					}
					return { results: [] };
				},
				async run() {
					queries.push({ sql, binds: this._binds || [] });
					if (handlers.run) {
						return handlers.run(sql, this._binds || []);
					}
					return { success: true };
				},
			};
		},
	};
}

test("getUserLastReadMessageId 准确返回用户在该频道的最新已读消息 ID", async () => {
	const db = createMockDb({
		all(sql, _binds) {
			if (sql.includes("FROM message_reads")) {
				return { results: [{ last_read_message_id: 42 }] };
			}
			return { results: [] };
		},
	});

	const lastReadId = await getUserLastReadMessageId(db, { channelId: 10, userId: 2 });
	assert.equal(lastReadId, 42);
	assert.equal(db.queries.length, 1);
	assert.deepEqual(db.queries[0].binds, [10, 2]);
});

test("getPeerLastReadMessageId 在私聊中准确查询对方成员的已读 ID", async () => {
	const db = createMockDb({
		all(sql, binds) {
			if (sql.includes("JOIN channel_members cm")) {
				assert.deepEqual(binds, [10, 2]);
				return { results: [{ last_read_message_id: 88 }] };
			}
			return { results: [] };
		},
	});

	const peerReadId = await getPeerLastReadMessageId(db, { channelId: 10, myUserId: 2 });
	assert.equal(peerReadId, 88);
});

test("getPeerLastReadMessageId 在没有已读记录时返回 0", async () => {
	const db = createMockDb({
		all() {
			return { results: [] };
		},
	});

	const peerReadId = await getPeerLastReadMessageId(db, { channelId: 1, myUserId: 2 });
	assert.equal(peerReadId, 0);
});

test("listMessages 为私聊当前用户发送的消息附加 isReadByPeer 与 deliveryStatus", async () => {
	const rawMessages = [
		{
			id: "100",
			content: "hello unread",
			created_at: "2026-09-05T10:01:00Z",
			sender_id: 1,
			sender_username: "me",
			sender_display_name: "Me",
		},
		{
			id: "90",
			content: "hello read",
			created_at: "2026-09-05T10:00:00Z",
			sender_id: 1,
			sender_username: "me",
			sender_display_name: "Me",
		},
		{
			id: "85",
			content: "reply from peer",
			created_at: "2026-09-05T09:59:00Z",
			sender_id: 2,
			sender_username: "peer",
			sender_display_name: "Peer",
		},
	];

	const db = createMockDb({
		all(sql) {
			if (sql.includes("FROM messages m")) {
				return { results: rawMessages };
			}
			if (sql.includes("JOIN channel_members cm")) {
				return { results: [{ last_read_message_id: 95 }] }; // 对方已读到 95
			}
			return { results: [] };
		},
	});

	const messages = await listMessages(
		{ DB: db },
		10,
		null,
		20,
		{ currentUserId: 1, roomKind: "dm" }
	);

	assert.equal(messages.length, 3);
	// 升序排列：85, 90, 100
	const [msg85, msg90, msg100] = messages;

	// msg85 来自对方，不附加 isReadByPeer
	assert.equal(msg85.id, 85);
	assert.equal(msg85.isReadByPeer, undefined);

	// msg90 由当前用户发出，id <= 95，因此已读
	assert.equal(msg90.id, 90);
	assert.equal(msg90.isReadByPeer, true);
	assert.equal(msg90.deliveryStatus, "read");

	// msg100 由当前用户发出，id > 95，因此未读
	assert.equal(msg100.id, 100);
	assert.equal(msg100.isReadByPeer, false);
	assert.equal(msg100.deliveryStatus, "sent");
});

test("broadcastRoomReadReceipt 携带正确的数据结构与鉴权头调用 ChannelRoom", async () => {
	let capturedRequest = null;
	const roomStub = {
		async fetch(input, init) {
			capturedRequest = input instanceof Request ? input : new Request(input, init);
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "Content-Type": "application/json" },
			});
		},
	};

	const env = {
		CHANNEL_ROOM: {
			idFromName(name) {
				assert.equal(name, "dm:12");
				return "stub-id";
			},
			get() {
				return roomStub;
			},
		},
	};

	const res = await broadcastRoomReadReceipt(env, {
		room: { id: 12, kind: "dm" },
		userId: 7,
		lastReadMessageId: 105,
	});

	assert.ok(res.ok);
	assert.ok(capturedRequest);
	assert.equal(new URL(capturedRequest.url).pathname, "/read-receipt");
	assert.equal(capturedRequest.method, "POST");
	assert.equal(capturedRequest.headers.get("x-cfchat-internal-auth"), "worker-verified");

	const body = await capturedRequest.json();
	assert.deepEqual(body, {
		room: { id: 12, kind: "dm" },
		userId: 7,
		lastReadMessageId: 105,
	});
});

test("ChannelRoom.receiveReadReceipt 校验内部鉴权并广播 read_receipt 事件", async () => {
	const room = new ChannelRoom({}, {});
	const capturedPackets = [];

	// Mock broadcast
	room.broadcast = async (packet) => {
		capturedPackets.push(JSON.parse(packet));
	};

	// 1. 未授权调用被拦截
	const unauthReq = new Request("https://internal/read-receipt", {
		method: "POST",
		body: JSON.stringify({}),
	});
	const unauthRes = await room.receiveReadReceipt(unauthReq);
	assert.equal(unauthRes.status, 401);

	// 2. 授权调用成功广播
	const validReq = new Request("https://internal/read-receipt", {
		method: "POST",
		headers: {
			"x-cfchat-internal-auth": "worker-verified",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			room: { id: 8, kind: "dm" },
			userId: 3,
			lastReadMessageId: 99,
		}),
	});
	const validRes = await room.receiveReadReceipt(validReq);
	assert.equal(validRes.status, 200);

	assert.equal(capturedPackets.length, 1);
	assert.deepEqual(capturedPackets[0], {
		protocolVersion: 1,
		type: "read_receipt",
		roomId: 8,
		roomKind: "dm",
		readUpToId: 99,
		readerUserId: 3,
	});
});
