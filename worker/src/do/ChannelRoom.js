import {
  MessageSubmissionError,
  submitRoomMessage,
  submitRoomMessageIdempotent
} from '../message-submission.js';
import { deleteRoomMessage, MessageDeletionError } from '../message-deletion.js';
import { editRoomMessage, MessageEditingError } from '../message-editing.js';
import {
  MessagePinningError,
  pinRoomMessage,
  unpinRoomMessage
} from '../message-pinning.js';
import { submitExternalMessage } from '../external-message-submission.js';
import { forwardEdgeChatMessageToTelegram } from '../integrations/telegram/bridge.js';
import { authorizeRoom } from '../room-access.js';
import { validateSession } from '../session.js';
import { projectUnreadMessage } from '../unread-projection.js';
import { isVerifiedInternalRequest, parseVerifiedPrincipal } from '../verified-identity.js';
import { markRoomRead } from '../data/unread.js';

const MESSAGE_SIZE_LIMIT = 10 * 1024;

function socketMeta(token, principal, room) {
  return {
    token,
    principal,
    room
  };
}

function sendSocketError(ws, message) {
  try {
    ws.send(JSON.stringify({ protocolVersion: 1, type: 'error', error: message }));
  } catch {
    // Ignore broken sockets.
  }
}

function getMessageByteLength(message) {
  if (typeof message === 'string') {
    return new TextEncoder().encode(message).length;
  }
  if (message instanceof ArrayBuffer) {
    return message.byteLength;
  }
  if (ArrayBuffer.isView(message)) {
    return message.byteLength;
  }

  // 未知 WebSocket 消息类型无法可靠解析，按超大处理，避免绕过大小限制。
  return Number.MAX_SAFE_INTEGER;
}

function normalizeWebSocketMessage(message) {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return new TextDecoder().decode(message);
  }
  if (ArrayBuffer.isView(message)) {
    return new TextDecoder().decode(message);
  }
  return '';
}

export class ChannelRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Map();

    const sockets = typeof this.state?.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : [];
    for (const socket of sockets) {
      const meta = socket.deserializeAttachment?.();
      if (meta) {
        this.connections.set(socket, meta);
      }
    }
  }

  parsePayload(ws, message) {
    try {
      return JSON.parse(message);
    } catch {
      sendSocketError(ws, 'Invalid message payload');
      return null;
    }
  }

  async revalidateConnection(ws, meta) {
    if (!meta?.token) {
      return null;
    }

    const auth = await validateSession(this.env, meta.token);
    if (!auth.ok) {
      this.closeUnauthorizedSocket(ws);
      return null;
    }

    const access = await authorizeRoom(
      this.env.DB,
      auth.session,
      meta.room.kind,
      meta.room.id
    );
    if (!access.ok) {
      this.closeUnauthorizedSocket(ws);
      return null;
    }

    const { room } = access;

    const nextMeta = socketMeta(
      meta.token,
      {
        userId: auth.session.userId,
        isAdmin: auth.session.isAdmin
      },
      room
    );
    this.connections.set(ws, nextMeta);
    ws.serializeAttachment(nextMeta);
    return nextMeta;
  }

  closeUnauthorizedSocket(ws) {
    this.connections.delete(ws);
    try {
      ws.close(1008, 'Unauthorized');
    } catch {
      // Ignore broken sockets.
    }
  }

  async broadcast(packet) {
    const connections = [...this.connections.entries()];
    const validated = await Promise.all(
      connections.map(async ([socket, meta]) => ({
        socket,
        meta: await this.revalidateConnection(socket, meta)
      }))
    );

    for (const { socket, meta } of validated) {
      if (!meta) continue;
      try {
        socket.send(packet);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  broadcastExcept(packet, exceptSocket) {
    for (const socket of this.connections.keys()) {
      if (socket === exceptSocket) continue;
      try {
        socket.send(packet);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  runMessageProjections(room, message) {
    this.state.waitUntil(
      Promise.all([
        projectUnreadMessage(this.env, {
          room,
          senderId: message.sender.kind === 'local' ? message.sender.id : null,
          message
        }),
        forwardEdgeChatMessageToTelegram(this.env, { room, message })
      ])
    );
  }

  async receiveExternalMessage(request) {
    if (!isVerifiedInternalRequest(request)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = await request.json();
    const room = payload.room;
    if (room?.kind !== 'public' || !Number.isInteger(Number(room.id))) {
      return new Response('Invalid room', { status: 400 });
    }

    const result = await submitExternalMessage(this.env, { room, payload });
    if (result.created) {
      await this.broadcast(result.packet);
      this.runMessageProjections(room, result.message);
    }
    return Response.json({ ok: true, created: result.created, message: result.message });
  }

  async receiveReadReceipt(request) {
    if (!isVerifiedInternalRequest(request)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = await request.json();
    const { room, userId, lastReadMessageId } = payload;
    const packet = JSON.stringify({
      protocolVersion: 1,
      type: 'read_receipt',
      roomId: Number(room?.id || 0),
      roomKind: room?.kind || 'public',
      readUpToId: Number(lastReadMessageId || 0),
      readerUserId: Number(userId || 0)
    });
    await this.broadcast(packet);
    return Response.json({ ok: true });
  }

  async receiveClientAction(request) {
    if (!isVerifiedInternalRequest(request)) {
      return Response.json(
        { error: { code: 'authentication_required', message: '请先登录' } },
        { status: 401 }
      );
    }

    const principal = parseVerifiedPrincipal(request);
    const payload = await request.json();
    const room = payload.room;
    const action = payload.action;
    const access = principal
      ? await authorizeRoom(this.env.DB, principal, room?.kind, Number(room?.id))
      : { ok: false };
    if (!access.ok) {
      return Response.json(
        { error: { code: 'forbidden', message: '无权访问该会话' } },
        { status: 403 }
      );
    }

    const meta = { principal, room: access.room };
    try {
      if (action?.type === 'send') {
        const result = await submitRoomMessageIdempotent(this.env, meta, action);
        if (result.created) {
          await this.broadcast(result.packet);
          this.runMessageProjections(access.room, result.message);
        }
        return Response.json({ created: result.created, message: result.message });
      }
      if (action?.type === 'delete_message' || action?.type === 'recall_message') {
        const result = await deleteRoomMessage(this.env, meta, action);
        await this.broadcast(result.packet);
        return Response.json({ ok: true, messageId: result.messageId });
      }
      if (action?.type === 'edit_message') {
        const result = await editRoomMessage(this.env, meta, action);
        await this.broadcast(result.packet);
        return Response.json({ ok: true, message: result.message });
      }
      if (action?.type === 'pin_message') {
        const result = await pinRoomMessage(this.env, meta, action);
        await this.broadcast(result.packet);
        return Response.json({ ok: true, message: result.message });
      }
      if (action?.type === 'unpin_message') {
        const result = await unpinRoomMessage(this.env, meta, action);
        await this.broadcast(result.packet);
        return Response.json({ ok: true, messageId: result.messageId });
      }
      if (action?.type === 'read' || action?.type === 'mark_read') {
        const lastReadMessageId = await markRoomRead(this.env.DB, {
          channelId: access.room.id,
          userId: principal.userId,
          messageId: action.messageId
        });
        const packet = JSON.stringify({
          protocolVersion: 1,
          type: 'read_receipt',
          roomId: Number(access.room.id),
          roomKind: access.room.kind,
          readUpToId: lastReadMessageId,
          readerUserId: Number(principal.userId)
        });
        await this.broadcast(packet);
        return Response.json({ ok: true, lastReadMessageId });
      }
      return Response.json(
        { error: { code: 'invalid_request', message: '不支持的消息操作' } },
        { status: 400 }
      );
    } catch (error) {
      if (
        error instanceof MessageSubmissionError ||
        error instanceof MessageDeletionError ||
        error instanceof MessagePinningError ||
        error instanceof MessageEditingError
      ) {
        return Response.json(
          { error: { code: error.code || 'invalid_request', message: error.message } },
          { status: error.status || 400 }
        );
      }
      console.error(JSON.stringify({
        message: 'client room action failed',
        roomId: Number(access.room.id),
        error: error instanceof Error ? error.message : String(error)
      }));
      return Response.json(
        { error: { code: 'internal_error', message: '消息操作失败' } },
        { status: 500 }
      );
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/external-message' && request.method === 'POST') {
      return this.receiveExternalMessage(request);
    }

    if (url.pathname === '/client-action' && request.method === 'POST') {
      return this.receiveClientAction(request);
    }

    if (url.pathname === '/read-receipt' && request.method === 'POST') {
      return this.receiveReadReceipt(request);
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const token = url.searchParams.get('token') || '';
    const kind = url.searchParams.get('kind') || '';
    const roomId = Number(url.searchParams.get('id') || '');

    let principal = parseVerifiedPrincipal(request);
    if (!principal) {
      const auth = await validateSession(this.env, token);
      if (!auth.ok) {
        return new Response('Unauthorized', { status: 401 });
      }

      principal = {
        userId: auth.session.userId,
        isAdmin: auth.session.isAdmin
      };
    }

    const access = await authorizeRoom(this.env.DB, principal, kind, roomId);

    if (!access.ok) {
      return new Response('Forbidden', { status: 403 });
    }
    const { room } = access;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    const meta = socketMeta(token, principal, room);
    server.serializeAttachment(meta);
    this.connections.set(server, meta);
    server.send(
      JSON.stringify({
        protocolVersion: 1,
        type: 'ready',
        room: {
          id: Number(room.id),
          kind: room.kind,
          name: room.name
        }
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const meta = this.connections.get(ws);
    if (!meta) {
      return;
    }

    if (getMessageByteLength(message) > MESSAGE_SIZE_LIMIT) {
      sendSocketError(ws, `消息过大，最大 ${Math.round(MESSAGE_SIZE_LIMIT / 1024)}KB`);
      return;
    }

    const payload = this.parsePayload(ws, normalizeWebSocketMessage(message));
    if (!payload) {
      return;
    }

    if (!['send', 'delete_message', 'recall_message', 'edit_message', 'typing', 'pin_message', 'unpin_message', 'read', 'mark_read'].includes(payload.type)) {
      sendSocketError(ws, 'Unsupported message type');
      return;
    }

    if (payload.type === 'typing') {
      const packet = JSON.stringify({
        protocolVersion: 1,
        type: 'typing',
        roomId: Number(meta.room.id),
        roomKind: meta.room.kind,
        userId: Number(meta.principal.userId),
        isTyping: Boolean(payload.isTyping ?? true),
      });
      this.broadcastExcept(packet, ws);
      return;
    }

    try {
      const currentMeta = await this.revalidateConnection(ws, meta);
      if (!currentMeta) {
        return;
      }

      if (payload.type === 'delete_message' || payload.type === 'recall_message') {
        const { packet } = await deleteRoomMessage(this.env, currentMeta, payload);
        await this.broadcast(packet);
        return;
      }
      if (payload.type === 'edit_message') {
        const { packet } = await editRoomMessage(this.env, currentMeta, payload);
        await this.broadcast(packet);
        return;
      }
      if (payload.type === 'pin_message') {
        const { packet } = await pinRoomMessage(this.env, currentMeta, payload);
        await this.broadcast(packet);
        return;
      }
      if (payload.type === 'unpin_message') {
        const { packet } = await unpinRoomMessage(this.env, currentMeta, payload);
        await this.broadcast(packet);
        return;
      }
      if (payload.type === 'read' || payload.type === 'mark_read') {
        const lastReadMessageId = await markRoomRead(this.env.DB, {
          channelId: currentMeta.room.id,
          userId: currentMeta.principal.userId,
          messageId: payload.messageId
        });
        const packet = JSON.stringify({
          protocolVersion: 1,
          type: 'read_receipt',
          roomId: Number(currentMeta.room.id),
          roomKind: currentMeta.room.kind,
          readUpToId: lastReadMessageId,
          readerUserId: Number(currentMeta.principal.userId)
        });
        await this.broadcast(packet);
        return;
      }

      const { message: saved, packet } = await submitRoomMessage(
        this.env,
        currentMeta,
        payload
      );
      await this.broadcast(packet);
      // 未读与外部桥接都属于提交后投影，异步执行以缩短 WebSocket 发送链路。
      this.runMessageProjections(currentMeta.room, saved);
    } catch (error) {
      if (
        error instanceof MessageSubmissionError ||
        error instanceof MessageDeletionError ||
        error instanceof MessagePinningError ||
        error instanceof MessageEditingError
      ) {
        sendSocketError(ws, error.message);
        return;
      }
      console.error(JSON.stringify({
        message: 'room message action failed',
        roomId: Number(meta.room?.id || 0),
        error: error instanceof Error ? error.message : String(error)
      }));
      sendSocketError(ws, '消息操作失败');
    }
  }

  webSocketClose(ws) {
    this.connections.delete(ws);
  }

  webSocketError(ws) {
    this.connections.delete(ws);
  }
}
