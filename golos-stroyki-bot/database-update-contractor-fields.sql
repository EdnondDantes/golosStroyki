-- Этап 3: Обновление анкеты специалиста
-- Добавление новых полей в таблицу contractors

-- Добавляем новые поля
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS ready_for_trips BOOLEAN DEFAULT false;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS professional_advantages TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS auto_hook TEXT;

-- Переименовываем существующее поле
ALTER TABLE contractors RENAME COLUMN documents_form TO cooperation_format;

-- Комментарии к полям
COMMENT ON COLUMN contractors.name IS 'Имя специалиста/бригадира/компании';
COMMENT ON COLUMN contractors.ready_for_trips IS 'Готовность к командировкам (да/нет)';
COMMENT ON COLUMN contractors.professional_advantages IS 'Профессиональные преимущества (необязательное поле)';
COMMENT ON COLUMN contractors.cooperation_format IS 'Формат сотрудничества (переименовано из documents_form)';
COMMENT ON COLUMN contractors.category IS 'Категория специалиста';
COMMENT ON COLUMN contractors.auto_hook IS 'Наличие автокрана/автовышки';

-- Создаем индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_contractors_ready_for_trips ON contractors(ready_for_trips);
CREATE INDEX IF NOT EXISTS idx_contractors_category ON contractors(category);
CREATE INDEX IF NOT EXISTS idx_contractors_auto_hook ON contractors(auto_hook);

-- Проверочные запросы
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'contractors' AND column_name IN ('name', 'ready_for_trips', 'professional_advantages', 'cooperation_format', 'category', 'auto_hook');
