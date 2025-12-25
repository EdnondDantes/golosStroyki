-- Миграция: Добавление поля hook для цепляющих фраз
-- Дата: 2025-12-25

-- Добавляем поле hook в таблицу contractors
ALTER TABLE contractors
ADD COLUMN hook TEXT;

COMMENT ON COLUMN contractors.hook IS 'Короткая цепляющая фраза (хук) для привлечения внимания, генерируется AI';

-- Добавляем поле hook в таблицу orders
ALTER TABLE orders
ADD COLUMN hook TEXT;

COMMENT ON COLUMN orders.hook IS 'Короткая цепляющая фраза (хук) для привлечения внимания, генерируется AI';
