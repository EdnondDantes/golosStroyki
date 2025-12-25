-- ==================== МИГРАЦИЯ: Таблица для хранения ролей пользователей ====================
--
-- Эта таблица сохраняет роль каждого пользователя, выбранную один раз при первом входе в бот.
-- Роль используется при создании анкет и заявок для лучшей персонализации.
--
-- Статус: НОВОЕ - добавлено для постоянного хранения ролей пользователей
-- Дата: 2025-12-24

CREATE TABLE IF NOT EXISTS user_roles (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL UNIQUE,
  role VARCHAR(50) NOT NULL CHECK (role IN ('рабочий', 'бригадир', 'подрядчик/компания', 'заказчик', 'эксперт', 'наблюдатель')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Индекс для быстрого поиска по telegram_id
CREATE INDEX IF NOT EXISTS idx_user_roles_telegram_id ON user_roles(telegram_id);

-- Триггер для автоматического обновления поля updated_at
CREATE OR REPLACE FUNCTION update_user_roles_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_user_roles_timestamp ON user_roles;
CREATE TRIGGER trigger_user_roles_timestamp
BEFORE UPDATE ON user_roles
FOR EACH ROW
EXECUTE FUNCTION update_user_roles_timestamp();

-- ==================== ПРИМЕРЫ ИСПОЛЬЗОВАНИЯ ====================
--
-- 1. Вставка новой роли пользователя:
-- INSERT INTO user_roles (telegram_id, role) VALUES (12345678, 'подрядчик/компания');
--
-- 2. Получение роли пользователя:
-- SELECT role FROM user_roles WHERE telegram_id = 12345678;
--
-- 3. Обновление роли:
-- UPDATE user_roles SET role = 'заказчик' WHERE telegram_id = 12345678;
--
-- ==================== КОММЕНТАРИИ К ПОЛЯМ ====================
--
-- id: Уникальный идентификатор записи в таблице
-- telegram_id: ID пользователя в Telegram (уникален в таблице)
-- role: Роль пользователя (один из: 'рабочий', 'бригадир', 'подрядчик/компания', 'заказчик', 'эксперт', 'наблюдатель')
-- created_at: Дата и время создания записи
-- updated_at: Дата и время последнего обновления записи (обновляется автоматически)
