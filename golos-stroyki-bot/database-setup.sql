-- ============================================
-- Настройка базы данных Supabase
-- для проекта "Голос Стройки"
-- ============================================

-- 1. Создание таблицы подрядчиков
CREATE TABLE IF NOT EXISTS contractors (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  telegram_id BIGINT NOT NULL,
  username TEXT,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  specialization TEXT NOT NULL,
  experience TEXT NOT NULL,
  description TEXT NOT NULL,
  price TEXT NOT NULL,
  portfolio_link TEXT,
  contact TEXT NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL,
  
  -- Дополнительные поля для будущего функционала
  rating NUMERIC(3, 2) DEFAULT 0.0,
  reviews_count INTEGER DEFAULT 0,
  views_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Создание индексов для оптимизации поиска
CREATE INDEX IF NOT EXISTS idx_contractors_telegram_id ON contractors(telegram_id);
CREATE INDEX IF NOT EXISTS idx_contractors_status ON contractors(status);
CREATE INDEX IF NOT EXISTS idx_contractors_city ON contractors(city);
CREATE INDEX IF NOT EXISTS idx_contractors_created_at ON contractors(created_at DESC);

-- 3. Создание функции для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 4. Создание триггера для обновления updated_at при изменении записи
DROP TRIGGER IF EXISTS update_contractors_updated_at ON contractors;
CREATE TRIGGER update_contractors_updated_at
    BEFORE UPDATE ON contractors
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 5. Создание таблицы для жалоб (опционально)
CREATE TABLE IF NOT EXISTS complaints (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  telegram_id BIGINT NOT NULL,
  contractor_id BIGINT REFERENCES contractors(id),
  message TEXT NOT NULL,
  status TEXT DEFAULT 'new' NOT NULL,
  resolved_at TIMESTAMPTZ,
  telegram_tag TEXT
);

CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);

COMMENT ON COLUMN complaints.telegram_tag IS 'Username в Telegram пользователя, отправившего жалобу (@username)';
CREATE INDEX IF NOT EXISTS idx_complaints_contractor_id ON complaints(contractor_id);

-- 6. Создание таблицы для отзывов (опционально, для будущего функционала)
CREATE TABLE IF NOT EXISTS reviews (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  contractor_id BIGINT REFERENCES contractors(id) NOT NULL,
  client_telegram_id BIGINT NOT NULL,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5) NOT NULL,
  comment TEXT,
  status TEXT DEFAULT 'pending' NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_contractor_id ON reviews(contractor_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status);

-- 7. Создание представления для статистики подрядчиков
CREATE OR REPLACE VIEW contractor_stats AS
SELECT 
  c.id,
  c.telegram_id,
  c.name,
  c.city,
  c.status,
  COUNT(DISTINCT r.id) as total_reviews,
  AVG(r.rating) as avg_rating,
  c.views_count
FROM contractors c
LEFT JOIN reviews r ON c.id = r.contractor_id AND r.status = 'approved'
GROUP BY c.id;

-- 8. Комментарии к таблицам и полям
COMMENT ON TABLE contractors IS 'Таблица анкет подрядчиков';
COMMENT ON COLUMN contractors.telegram_id IS 'ID пользователя в Telegram';
COMMENT ON COLUMN contractors.status IS 'Статус анкеты: pending (на модерации), approved (одобрена), rejected (отклонена)';
COMMENT ON COLUMN contractors.rating IS 'Средний рейтинг подрядчика (0-5)';
COMMENT ON COLUMN contractors.reviews_count IS 'Количество отзывов';
COMMENT ON COLUMN contractors.views_count IS 'Количество просмотров профиля';

-- 9. Добавление новых полей (гражданство, фото, номер телефона и telegram username)
-- Выполните эти команды, если таблица уже существует
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS citizenship TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE contractors ADD COLUMN IF NOT EXISTS telegram_tag TEXT;

COMMENT ON COLUMN contractors.citizenship IS 'Гражданство подрядчика';
COMMENT ON COLUMN contractors.photo_url IS 'URL фотографии профиля (опционально)';
COMMENT ON COLUMN contractors.phone_number IS 'Номер телефона подрядчика';
COMMENT ON COLUMN contractors.telegram_tag IS 'Username в Telegram (@username)';

-- 10. Добавление поля telegram_tag в таблицу complaints (если таблица уже существует)
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS telegram_tag TEXT;
COMMENT ON COLUMN complaints.telegram_tag IS 'Username в Telegram пользователя, отправившего жалобу (@username)';

-- ============================================
-- Полезные запросы для работы с данными
-- ============================================

-- Получить все анкеты на модерации
-- SELECT * FROM contractors WHERE status = 'pending' ORDER BY created_at DESC;

-- Получить все одобренные анкеты по городу
-- SELECT * FROM contractors WHERE status = 'approved' AND city = 'Москва' ORDER BY created_at DESC;

-- Одобрить анкету
-- UPDATE contractors SET status = 'approved' WHERE id = 1;

-- Отклонить анкету
-- UPDATE contractors SET status = 'rejected' WHERE id = 1;

-- Получить статистику по анкетам
-- SELECT status, COUNT(*) as count FROM contractors GROUP BY status;

-- Получить топ подрядчиков по рейтингу
-- SELECT * FROM contractor_stats WHERE status = 'approved' ORDER BY avg_rating DESC, total_reviews DESC LIMIT 10;

-- Поиск подрядчиков по специализации
-- SELECT * FROM contractors 
-- WHERE status = 'approved' 
-- AND specialization ILIKE '%отделка%' 
-- ORDER BY rating DESC;

-- ============================================
-- Настройки безопасности (RLS)
-- ============================================

-- Включить Row Level Security для таблицы contractors
-- ALTER TABLE contractors ENABLE ROW LEVEL SECURITY;

-- Политика: все могут читать одобренные анкеты
-- CREATE POLICY "Anyone can view approved contractors" ON contractors
-- FOR SELECT
-- USING (status = 'approved');

-- Политика: пользователь может создавать только свою анкету
-- CREATE POLICY "Users can create their own contractor profile" ON contractors
-- FOR INSERT
-- WITH CHECK (auth.uid()::text = telegram_id::text);

-- Политика: пользователь может редактировать только свою анкету
-- CREATE POLICY "Users can update their own contractor profile" ON contractors
-- FOR UPDATE
-- USING (auth.uid()::text = telegram_id::text);
