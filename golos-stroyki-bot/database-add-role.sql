-- Добавление поля role в таблицы contractors и orders
-- Создано для этапа 2: система ролей

-- Добавляем поле role в таблицу contractors
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS role TEXT;

-- Добавляем поле role в таблицу orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS role TEXT;

-- Добавляем поле role в таблицу suppliers (на всякий случай, если понадобится)
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS role TEXT;

-- Комментарии к полям
COMMENT ON COLUMN contractors.role IS 'Роль пользователя: рабочий, бригадир, подрядчик/компания, заказчик, эксперт, наблюдатель';
COMMENT ON COLUMN orders.role IS 'Роль пользователя: рабочий, бригадир, подрядчик/компания, заказчик, эксперт, наблюдатель';
COMMENT ON COLUMN suppliers.role IS 'Роль пользователя: рабочий, бригадир, подрядчик/компания, заказчик, эксперт, наблюдатель';

-- Создаем индексы для быстрого поиска по роли
CREATE INDEX IF NOT EXISTS idx_contractors_role ON contractors(role);
CREATE INDEX IF NOT EXISTS idx_orders_role ON orders(role);
CREATE INDEX IF NOT EXISTS idx_suppliers_role ON suppliers(role);

-- Проверка: посмотреть все роли в contractors
-- SELECT role, COUNT(*) as count FROM contractors WHERE role IS NOT NULL GROUP BY role;

-- Проверка: посмотреть все роли в orders
-- SELECT role, COUNT(*) as count FROM orders WHERE role IS NOT NULL GROUP BY role;
