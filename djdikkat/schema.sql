-- DJ DIKKAT - MariaDB schema (bot data)
-- Applied automatically on startup by db.js; every statement is idempotent.
-- All DATETIME columns are UTC.

-- One row per guild the bot has ever seen: directory info, settings, and the
-- IDs of the player card / stats card it currently has posted.
CREATE TABLE IF NOT EXISTS guilds (
  guild_id                VARCHAR(20)  NOT NULL PRIMARY KEY,
  name                    VARCHAR(100) NULL,
  icon_url                VARCHAR(255) NULL,
  member_count            INT UNSIGNED NULL,
  in_guild                TINYINT(1)   NOT NULL DEFAULT 1,
  joined_at               DATETIME(3)  NULL,
  left_at                 DATETIME(3)  NULL,
  default_text_channel_id VARCHAR(20)  NULL,  -- last channel a command was used in (auto)
  announce_channel_id     VARCHAR(20)  NULL,  -- admin-pinned announcement channel (wins over auto)
  last_command_at         DATETIME(3)  NULL,
  last_announcement_at    DATETIME(3)  NULL,
  ui_message_id           VARCHAR(20)  NULL,
  ui_channel_id           VARCHAR(20)  NULL,
  stats_message_id        VARCHAR(20)  NULL,
  stats_channel_id        VARCHAR(20)  NULL,
  stats_posted_at         DATETIME(3)  NULL,
  created_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every track started, forever. /history shows the newest 200 per guild.
CREATE TABLE IF NOT EXISTS plays (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  guild_id  VARCHAR(20)   NOT NULL,
  title     VARCHAR(512)  NOT NULL,
  url       VARCHAR(1024) NULL,
  user_id   VARCHAR(20)   NULL,
  user_tag  VARCHAR(100)  NULL,
  played_at DATETIME(3)   NOT NULL,
  KEY idx_plays_guild_time (guild_id, played_at),
  KEY idx_plays_time (played_at),
  KEY idx_plays_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Play counters:
--   period 'all' = all-time totals, 'YYYY-MM-DD' = one day (server local date, pruned after 30 days)
--   kind 'title' / 'url' / 'user' = per song / per link / per requester, 'plays' = day total
-- key_hash = MD5(item_key) so long titles/URLs can be part of the primary key.
CREATE TABLE IF NOT EXISTS stat_counters (
  guild_id VARCHAR(20)   NOT NULL,
  period   VARCHAR(10)   NOT NULL,
  kind     ENUM('title','url','user','plays') NOT NULL,
  key_hash BINARY(16)    NOT NULL,
  item_key VARCHAR(1024) NOT NULL,
  label    VARCHAR(512)  NULL,
  count    INT UNSIGNED  NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, period, kind, key_hash),
  KEY idx_stat_period_kind (period, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DMs the bot sent, so the admin panel can bulk-delete them later.
CREATE TABLE IF NOT EXISTS dm_messages (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  channel_id VARCHAR(20) NOT NULL,
  message_id VARCHAR(20) NOT NULL,
  type       VARCHAR(32) NOT NULL DEFAULT 'dm',
  created_at DATETIME(3) NOT NULL,
  KEY idx_dm_message (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NodeLink update runs, written by updater/auto-update-nodelink.sh.
-- The newest row is what /health shows as "Last Update".
CREATE TABLE IF NOT EXISTS update_history (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts               DATETIME(3) NOT NULL,
  trigger_src      VARCHAR(32) NOT NULL DEFAULT 'auto-cron',
  status           VARCHAR(32) NOT NULL,
  failed_at        VARCHAR(128) NULL,
  nodelink_updated TINYINT(1)  NOT NULL DEFAULT 0,
  commit_before    VARCHAR(40) NULL,
  commit_after     VARCHAR(40) NULL,
  KEY idx_update_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin-toggleable runtime settings that should survive a restart
-- (maintenance mode, cooldowns, log level, presence).
CREATE TABLE IF NOT EXISTS bot_config (
  name       VARCHAR(64) NOT NULL PRIMARY KEY,
  value      LONGTEXT    NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
