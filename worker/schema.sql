PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  avatar_key TEXT,
  registration_invite_id INTEGER UNIQUE,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  disabled_until TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  avatar_key TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
  dm_key TEXT UNIQUE,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  invited_by INTEGER,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (invited_by) REFERENCES users(id)
);

INSERT OR IGNORE INTO channels (name, description, kind, created_by)
VALUES ('general', '', 'public', NULL);

-- schema 可能会重复执行，幂等回填可顺手修复历史账号缺失的 general 成员关系。
INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
SELECT c.id, u.id, 'member', NULL
FROM channels c
CROSS JOIN users u
WHERE c.name = 'general'
  AND c.kind = 'public'
  AND c.deleted_at IS NULL
  AND u.deleted_at IS NULL;

-- 从数据库入口覆盖所有未来的建号路径，防止新入口忘记同步系统群成员关系。
CREATE TRIGGER IF NOT EXISTS add_new_user_to_general
AFTER INSERT ON users
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, invited_by)
  SELECT id, NEW.id, 'member', NULL
  FROM channels
  WHERE name = 'general'
    AND kind = 'public'
    AND deleted_at IS NULL;
END;

-- general 必须永久保留全部成员，数据库层兜底阻止任何遗漏的删除路径破坏不变量。
CREATE TRIGGER IF NOT EXISTS prevent_general_member_removal
BEFORE DELETE ON channel_members
WHEN EXISTS (
  SELECT 1
  FROM channels
  WHERE id = OLD.channel_id
    AND name = 'general'
)
BEGIN
  SELECT RAISE(ABORT, 'GENERAL_MEMBERSHIP_REQUIRED');
END;

-- 名称、公开属性和存活状态共同标识系统群，禁止绕过 API 改名、转私有或软删除。
CREATE TRIGGER IF NOT EXISTS protect_general_channel
BEFORE UPDATE OF name, kind, deleted_at ON channels
WHEN OLD.name = 'general'
  AND (
    NEW.name != 'general'
    OR NEW.kind != 'public'
    OR NEW.deleted_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'GENERAL_CHANNEL_REQUIRED');
END;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  sender_id INTEGER,
  content TEXT NOT NULL DEFAULT '',
  attachment_key TEXT,
  attachment_name TEXT,
  attachment_type TEXT,
  attachment_size INTEGER,
  sender_kind TEXT NOT NULL DEFAULT 'local' CHECK (sender_kind IN ('local', 'external')),
  external_sender_id TEXT,
  external_sender_name TEXT,
  external_sender_avatar_url TEXT,
  source TEXT NOT NULL DEFAULT 'edgechat',
  source_message_id TEXT,
  source_attachment_id TEXT,
  source_attachment_unique_id TEXT,
  client_message_id TEXT,
  mention_user_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at TEXT,
  deleted_at TEXT,
  CHECK (
    (sender_kind = 'local' AND sender_id IS NOT NULL)
    OR (sender_kind = 'external' AND sender_id IS NULL)
  ),
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS channel_pins (
  channel_id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL UNIQUE,
  pinned_by INTEGER,
  pinned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS message_reads (
  channel_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS site_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registration_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_by INTEGER,
  consumed_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  consumed_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (consumed_by_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS registration_invite_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_id INTEGER NOT NULL,
  user_id INTEGER,
  used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (invite_id, user_id),
  FOREIGN KEY (invite_id) REFERENCES registration_invites(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 校验和计数必须留在数据库事务内，防止并发注册同时消耗最后一次额度。
CREATE TRIGGER IF NOT EXISTS validate_registration_invite_use
BEFORE INSERT ON registration_invite_uses
BEGIN
  SELECT CASE
    WHEN NEW.user_id IS NULL THEN RAISE(ABORT, 'REGISTRATION_INVITE_USER_REQUIRED')
    WHEN NOT EXISTS (
      SELECT 1
      FROM registration_invites
      WHERE id = NEW.invite_id
        AND deleted_at IS NULL
        AND used_count < max_uses
    ) THEN RAISE(ABORT, 'REGISTRATION_INVITE_UNAVAILABLE')
  END;
END;

CREATE TRIGGER IF NOT EXISTS consume_registration_invite_use
AFTER INSERT ON registration_invite_uses
BEGIN
  UPDATE registration_invites
  SET used_count = used_count + 1,
      consumed_by_user_id = NEW.user_id,
      consumed_at = CASE
        WHEN used_count + 1 >= max_uses THEN CURRENT_TIMESTAMP
        ELSE NULL
      END
  WHERE id = NEW.invite_id;
END;

CREATE TABLE IF NOT EXISTS uploaded_files (
  object_key TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  client_upload_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  installation_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  refresh_token_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS realtime_tickets (
  token_hash TEXT PRIMARY KEY,
  access_token_ciphertext TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  device_session_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('room', 'inbox')),
  room_kind TEXT CHECK (room_kind IN ('public', 'private', 'dm')),
  room_id INTEGER,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_session_id) REFERENCES device_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'deleted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_event_compaction (
  channel_id INTEGER PRIMARY KEY,
  compacted_through INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

-- 由数据库在消息写入事务内生成同步游标，HTTP 与 WebSocket 两条提交入口不会产生不同步的事件。
CREATE TRIGGER IF NOT EXISTS record_message_created_event
AFTER INSERT ON messages
BEGIN
  INSERT INTO message_events (channel_id, message_id, event_type)
  VALUES (NEW.channel_id, NEW.id, 'created');
END;

CREATE TRIGGER IF NOT EXISTS record_message_deleted_event
AFTER UPDATE OF deleted_at ON messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  INSERT INTO message_events (channel_id, message_id, event_type)
  VALUES (NEW.channel_id, NEW.id, 'deleted');
END;

-- 软删除后立即移除置顶引用；消息保留期仍由 GC 独立决定，不因置顶而延长。
CREATE TRIGGER IF NOT EXISTS clear_pin_after_message_soft_delete
AFTER UPDATE OF deleted_at ON messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM channel_pins WHERE message_id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS pending_r2_delete (
  object_key TEXT PRIMARY KEY,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_bridge_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bot_token_ciphertext TEXT NOT NULL,
  webhook_secret_ciphertext TEXT NOT NULL,
  bot_username TEXT NOT NULL DEFAULT '',
  webhook_url TEXT NOT NULL DEFAULT '',
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS telegram_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL UNIQUE,
  telegram_chat_title TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO site_settings (setting_key, setting_value)
VALUES ('site_name', 'Edgechat');

INSERT OR IGNORE INTO site_settings (setting_key, setting_value)
VALUES ('site_icon_url', '');

CREATE INDEX IF NOT EXISTS idx_messages_channel_created
  ON messages(channel_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON messages(sender_id, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_source
  ON messages(source, source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_channel_client_message
  ON messages(channel_id, sender_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_reads_user
  ON message_reads(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_channels_kind
  ON channels(kind, id DESC);

CREATE INDEX IF NOT EXISTS idx_users_username
  ON users(username);

CREATE INDEX IF NOT EXISTS idx_registration_invites_active
  ON registration_invites(created_at DESC, deleted_at, consumed_at);

CREATE INDEX IF NOT EXISTS idx_registration_invites_usage
  ON registration_invites(deleted_at, used_count, max_uses, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_registration_invite_uses_invite
  ON registration_invite_uses(invite_id, used_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_r2_delete_next_retry
  ON pending_r2_delete(next_retry_at, retry_count);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_owner
  ON uploaded_files(owner_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_uploaded_files_client_upload
  ON uploaded_files(owner_user_id, client_upload_id)
  WHERE client_upload_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sessions_refresh_token
  ON device_sessions(refresh_token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_sessions_user_installation_active
  ON device_sessions(user_id, installation_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_device_sessions_user_active
  ON device_sessions(user_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_realtime_tickets_expiry
  ON realtime_tickets(expires_at, consumed_at);

CREATE INDEX IF NOT EXISTS idx_message_events_channel_sequence
  ON message_events(channel_id, sequence);

CREATE INDEX IF NOT EXISTS idx_telegram_mappings_channel
  ON telegram_mappings(channel_id, enabled, id);
