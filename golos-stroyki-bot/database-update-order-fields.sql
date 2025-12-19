-- Этап 4: Обновление заявки "Ищу людей"
-- Добавление новых полей в таблицу orders

-- Добавляем новые поля
ALTER TABLE orders ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS object_type TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS validity_period TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS task_hook TEXT;

-- Комментарии к полям
COMMENT ON COLUMN orders.company_name IS 'Имя или название компании (Шаг 7)';
COMMENT ON COLUMN orders.object_type IS 'Тип объекта: квартира, дом, ЖК и т.д.';
COMMENT ON COLUMN orders.validity_period IS 'Срок актуальности: 7 дней, 30 дней и т.д.';
COMMENT ON COLUMN orders.expires_at IS 'Дата истечения срока актуальности';
COMMENT ON COLUMN orders.category IS 'AI-определенная категория';
COMMENT ON COLUMN orders.task_hook IS 'Автогенерируемый хук для витрины';

-- Создаем индексы для оптимизации запросов
CREATE INDEX IF NOT EXISTS idx_orders_expires_at ON orders(expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_object_type ON orders(object_type);
CREATE INDEX IF NOT EXISTS idx_orders_category ON orders(category);

-- Проверочные запросы
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'orders' AND column_name IN ('company_name', 'object_type', 'validity_period', 'expires_at', 'category', 'task_hook');
