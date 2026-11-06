-- 下载计数：按「套件名 + UTC 日期」聚合，一天一行，读时 SUM。
-- package 用套件名（不是文件名），这样发新版换文件名后计数仍能累计。
CREATE TABLE IF NOT EXISTS downloads (
  package    TEXT    NOT NULL,
  file       TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (package, day)
);

CREATE INDEX IF NOT EXISTS idx_downloads_day ON downloads (day);
