-- Миграция: Добавление поля для хранения ID поста в канале
-- Дата: 2025-12-25
-- Описание: Добавляет поле channel_post_id в таблицы contractors и orders
--           для сохранения номера сообщения из канала Telegram

-- Добавление поля channel_post_id в таблицу contractors (анкеты специалистов)
ALTER TABLE contractors
ADD COLUMN IF NOT EXISTS channel_post_id BIGINT DEFAULT NULL;

-- Комментарий к полю
COMMENT ON COLUMN contractors.channel_post_id IS 'ID сообщения в канале Telegram (для создания ссылок на посты)';

-- Добавление поля channel_post_id в таблицу orders (заявки заказчиков)
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS channel_post_id BIGINT DEFAULT NULL;

-- Комментарий к полю
COMMENT ON COLUMN orders.channel_post_id IS 'ID сообщения в канале Telegram (для создания ссылок на посты)';

-- Проверка: вывести структуру таблиц
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name IN ('contractors', 'orders')
-- AND column_name = 'channel_post_id';
