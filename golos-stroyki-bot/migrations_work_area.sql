-- Миграция: Добавление поля work_area (область работ)
-- Дата: 2025-12-25
-- Описание: Добавляет поле work_area в таблицы contractors и orders
--           для хранения области работ на основе категории

-- Добавление поля work_area в таблицу contractors (анкеты специалистов)
ALTER TABLE contractors
ADD COLUMN IF NOT EXISTS work_area TEXT DEFAULT NULL;

-- Комментарий к полю
COMMENT ON COLUMN contractors.work_area IS 'Область работ специалиста (определяется автоматически по категории)';

-- Добавление поля work_area в таблицу orders (заявки заказчиков)
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS work_area TEXT DEFAULT NULL;

-- Комментарий к полю
COMMENT ON COLUMN orders.work_area IS 'Область работ для заявки (определяется автоматически по категории)';

-- Проверка: вывести структуру таблиц
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name IN ('contractors', 'orders')
-- AND column_name = 'work_area';
