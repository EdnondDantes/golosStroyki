-- Таблица для отслеживания источников трафика пользователей
-- Создана для этапа 1: добавление стартового экрана

CREATE TABLE IF NOT EXISTS user_sources (
    id BIGSERIAL PRIMARY KEY,
    telegram_id BIGINT NOT NULL,
    source VARCHAR(50) NOT NULL, -- инста, тикток, ютуб, статьи, контекст, другое
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Индекс для быстрого поиска по telegram_id
    CONSTRAINT idx_telegram_id UNIQUE (telegram_id)
);

-- Комментарии к полям
COMMENT ON TABLE user_sources IS 'Таблица для отслеживания откуда пришли пользователи в бота';
COMMENT ON COLUMN user_sources.telegram_id IS 'ID пользователя в Telegram';
COMMENT ON COLUMN user_sources.source IS 'Источник трафика: инста, тикток, ютуб, статьи, контекст, другое';
COMMENT ON COLUMN user_sources.created_at IS 'Дата первого взаимодействия пользователя с ботом';

-- Индексы для оптимизации запросов
CREATE INDEX idx_user_sources_telegram_id ON user_sources(telegram_id);
CREATE INDEX idx_user_sources_source ON user_sources(source);
CREATE INDEX idx_user_sources_created_at ON user_sources(created_at DESC);
