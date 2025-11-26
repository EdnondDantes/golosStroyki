# 📚 РАБОТА С SUPABASE - ПОДРОБНОЕ РУКОВОДСТВО

## 🎯 Что такое Supabase?

Supabase - это open-source альтернатива Firebase. Предоставляет:
- PostgreSQL базу данных
- Real-time обновления
- Аутентификацию
- Storage для файлов
- REST API из коробки

## 🚀 СОЗДАНИЕ И НАСТРОЙКА ПРОЕКТА

### Шаг 1: Регистрация

1. Перейдите на https://supabase.com
2. Нажмите "Start your project"
3. Войдите через GitHub (рекомендуется) или Email

### Шаг 2: Создание проекта

```
Dashboard → New Project

Заполните:
├── Organization: выберите свою организацию
├── Name: golossroyki-bot
├── Database Password: создайте сложный пароль
├── Region: выберите ближайший (например, Frankfurt для России)
└── Pricing Plan: Free (0$/месяц)
```

**Важно:** Сохраните Database Password - он понадобится для прямого подключения!

### Шаг 3: Получение учетных данных

После создания проекта (1-2 минуты):

```
Settings (⚙️) → API

Скопируйте:
1. Project URL: https://xxxxxxxxx.supabase.co
2. anon public key: eyJhbGc... (длинная строка)
```

## 📊 СОЗДАНИЕ ТАБЛИЦЫ CONTRACTORS

### Способ 1: SQL Editor (рекомендуется)

1. В боковом меню выберите **SQL Editor**
2. Нажмите **New query**
3. Вставьте SQL код:

```sql
-- ==========================================
-- ТАБЛИЦА ПОДРЯДЧИКОВ
-- ==========================================

-- Создание основной таблицы
CREATE TABLE contractors (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    username TEXT,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    specialization TEXT NOT NULL,
    experience TEXT NOT NULL,
    description TEXT NOT NULL,
    price TEXT NOT NULL,
    portfolio TEXT,
    contacts TEXT NOT NULL,
    status TEXT DEFAULT 'moderation' CHECK (status IN ('moderation', 'approved', 'rejected')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для быстрого поиска
CREATE INDEX idx_contractors_user_id ON contractors(user_id);
CREATE INDEX idx_contractors_city ON contractors(city);
CREATE INDEX idx_contractors_status ON contractors(status);
CREATE INDEX idx_contractors_specialization ON contractors USING GIN (to_tsvector('russian', specialization));
CREATE INDEX idx_contractors_created_at ON contractors(created_at DESC);

-- Функция автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Триггер для автоматического обновления updated_at
CREATE TRIGGER update_contractors_updated_at 
    BEFORE UPDATE ON contractors 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Комментарии к колонкам (документация)
COMMENT ON TABLE contractors IS 'Каталог подрядчиков строительных работ';
COMMENT ON COLUMN contractors.id IS 'Уникальный идентификатор анкеты';
COMMENT ON COLUMN contractors.user_id IS 'Telegram ID пользователя';
COMMENT ON COLUMN contractors.username IS 'Username в Telegram (может быть NULL)';
COMMENT ON COLUMN contractors.name IS 'Имя мастера или название компании';
COMMENT ON COLUMN contractors.city IS 'Город работы';
COMMENT ON COLUMN contractors.specialization IS 'Специализация (какие работы выполняет)';
COMMENT ON COLUMN contractors.experience IS 'Опыт работы (например: "5 лет")';
COMMENT ON COLUMN contractors.description IS 'Описание - почему выбрать именно его';
COMMENT ON COLUMN contractors.price IS 'Ориентировочные цены';
COMMENT ON COLUMN contractors.portfolio IS 'Ссылка на портфолио или примеры работ';
COMMENT ON COLUMN contractors.contacts IS 'Контакты для связи';
COMMENT ON COLUMN contractors.status IS 'Статус модерации: moderation, approved, rejected';
COMMENT ON COLUMN contractors.created_at IS 'Дата создания анкеты';
COMMENT ON COLUMN contractors.updated_at IS 'Дата последнего обновления';

-- ==========================================
-- ROW LEVEL SECURITY (RLS)
-- ==========================================

-- Включаем RLS
ALTER TABLE contractors ENABLE ROW LEVEL SECURITY;

-- Политика: все могут читать одобренные анкеты
CREATE POLICY "Публичный доступ к одобренным анкетам"
ON contractors FOR SELECT
USING (status = 'approved');

-- Политика: все могут создавать новые анкеты
CREATE POLICY "Любой может создать анкету"
ON contractors FOR INSERT
WITH CHECK (true);

-- Политика: пользователь может обновлять только свои анкеты на модерации
CREATE POLICY "Обновление своих анкет на модерации"
ON contractors FOR UPDATE
USING (user_id = auth.uid()::bigint AND status = 'moderation');

-- Политика для администраторов (если будет админ-панель)
-- CREATE POLICY "Админы могут всё"
-- ON contractors FOR ALL
-- USING (auth.jwt() ->> 'role' = 'admin');

-- ==========================================
-- ПОЛЕЗНЫЕ ФУНКЦИИ
-- ==========================================

-- Функция для подсчета анкет по статусам
CREATE OR REPLACE FUNCTION get_contractors_stats()
RETURNS TABLE (
    total BIGINT,
    on_moderation BIGINT,
    approved BIGINT,
    rejected BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'moderation') as on_moderation,
        COUNT(*) FILTER (WHERE status = 'approved') as approved,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected
    FROM contractors;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- ГОТОВО!
-- ==========================================
```

4. Нажмите **Run** (или F5)
5. Должно появиться: "Success. No rows returned"

### Способ 2: Table Editor (визуальный)

1. Перейдите в **Table Editor**
2. Нажмите **New table**
3. Вручную создайте все поля (не рекомендуется - долго)

## 🔍 ПРОВЕРКА ТАБЛИЦЫ

### Через Table Editor

1. Перейдите в **Table Editor**
2. Выберите таблицу **contractors**
3. Вы должны увидеть пустую таблицу со всеми колонками

### Через SQL

```sql
-- Проверка структуры таблицы
SELECT 
    column_name, 
    data_type, 
    is_nullable
FROM information_schema.columns
WHERE table_name = 'contractors'
ORDER BY ordinal_position;

-- Проверка индексов
SELECT indexname, indexdef 
FROM pg_indexes 
WHERE tablename = 'contractors';

-- Проверка политик RLS
SELECT * FROM pg_policies 
WHERE tablename = 'contractors';
```

## 📝 ПРИМЕРЫ ЗАПРОСОВ

### Просмотр всех анкет

```sql
SELECT * FROM contractors 
ORDER BY created_at DESC;
```

### Просмотр анкет на модерации

```sql
SELECT 
    id,
    name,
    city,
    specialization,
    created_at
FROM contractors 
WHERE status = 'moderation'
ORDER BY created_at ASC;
```

### Одобрение анкеты

```sql
UPDATE contractors 
SET status = 'approved' 
WHERE id = 1;
```

### Отклонение анкеты

```sql
UPDATE contractors 
SET status = 'rejected' 
WHERE id = 2;
```

### Поиск подрядчиков по городу

```sql
SELECT * FROM contractors 
WHERE status = 'approved' 
  AND city ILIKE '%москва%'
ORDER BY created_at DESC;
```

### Поиск по специализации (полнотекстовый)

```sql
SELECT * FROM contractors 
WHERE status = 'approved' 
  AND to_tsvector('russian', specialization) @@ to_tsquery('russian', 'отделка | плитка')
ORDER BY created_at DESC;
```

### Статистика по городам

```sql
SELECT 
    city,
    COUNT(*) as total,
    COUNT(*) FILTER (WHERE status = 'approved') as approved
FROM contractors
GROUP BY city
ORDER BY total DESC;
```

### Получение общей статистики

```sql
SELECT * FROM get_contractors_stats();
```

## 🔐 НАСТРОЙКА БЕЗОПАСНОСТИ

### Включение RLS (Row Level Security)

RLS уже включен в SQL скрипте выше. Это означает:
- Пользователи видят только одобренные анкеты
- Создавать анкеты может кто угодно
- Обновлять анкеты могут только владельцы (если настроена аутентификация)

### Отключение RLS (для тестирования)

```sql
-- ВНИМАНИЕ: Только для разработки!
ALTER TABLE contractors DISABLE ROW LEVEL SECURITY;
```

### Создание service role ключа

Для административных операций:

1. **Settings → API**
2. Найдите **service_role key**
3. Скопируйте (используйте только на backend!)

⚠️ **service_role ключ обходит RLS! Не публикуйте его!**

## 📊 МОНИТОРИНГ И УПРАВЛЕНИЕ

### Database Health

```
Database → Reports

Смотрите:
├── Query Performance
├── Disk Usage
├── Connection Count
└── Error Logs
```

### Просмотр Real-time логов

```sql
-- Логи последних запросов
SELECT * FROM pg_stat_statements 
ORDER BY total_time DESC 
LIMIT 10;
```

### Бэкапы

Supabase автоматически создает бэкапы:
- Free tier: ежедневные бэкапы, хранятся 7 дней
- Restore через Dashboard → Database → Backups

### Экспорт данных

```sql
-- CSV экспорт (копируйте результат)
COPY (
    SELECT * FROM contractors WHERE status = 'approved'
) TO STDOUT WITH CSV HEADER;
```

## 🛠️ РАСШИРЕННЫЕ ВОЗМОЖНОСТИ

### Добавление полнотекстового поиска

```sql
-- Создание поискового индекса
CREATE INDEX idx_contractors_search ON contractors 
USING GIN (
    to_tsvector('russian', 
        coalesce(name, '') || ' ' || 
        coalesce(city, '') || ' ' || 
        coalesce(specialization, '') || ' ' || 
        coalesce(description, '')
    )
);

-- Пример поиска
SELECT *, 
    ts_rank(
        to_tsvector('russian', name || ' ' || specialization || ' ' || description),
        to_tsquery('russian', 'отделка & квартира')
    ) as rank
FROM contractors
WHERE status = 'approved'
  AND to_tsvector('russian', name || ' ' || specialization || ' ' || description) 
      @@ to_tsquery('russian', 'отделка & квартира')
ORDER BY rank DESC;
```

### Добавление рейтинга

```sql
-- Таблица отзывов
CREATE TABLE reviews (
    id BIGSERIAL PRIMARY KEY,
    contractor_id BIGINT REFERENCES contractors(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Вычисление среднего рейтинга
CREATE OR REPLACE VIEW contractors_with_rating AS
SELECT 
    c.*,
    COALESCE(AVG(r.rating), 0) as avg_rating,
    COUNT(r.id) as reviews_count
FROM contractors c
LEFT JOIN reviews r ON c.id = r.contractor_id
GROUP BY c.id;
```

### Геолокация (для карты)

```sql
-- Добавление координат
ALTER TABLE contractors 
ADD COLUMN latitude DECIMAL(10, 8),
ADD COLUMN longitude DECIMAL(11, 8);

-- Индекс для геопоиска
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE contractors 
ADD COLUMN location GEOGRAPHY(Point);

CREATE INDEX idx_contractors_location ON contractors 
USING GIST (location);

-- Поиск в радиусе 10км от точки
SELECT * FROM contractors
WHERE status = 'approved'
  AND ST_DWithin(
      location,
      ST_MakePoint(37.6173, 55.7558)::geography, -- Москва, Красная площадь
      10000 -- 10км в метрах
  )
ORDER BY ST_Distance(
    location,
    ST_MakePoint(37.6173, 55.7558)::geography
);
```

## 📱 ИНТЕГРАЦИЯ С PYTHON

### Основные операции

```python
from supabase import create_client

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# SELECT
data = supabase.table("contractors").select("*").eq("status", "approved").execute()

# INSERT
new_contractor = {
    "user_id": 123456789,
    "name": "Иван Петров",
    "city": "Москва",
    # ... остальные поля
}
result = supabase.table("contractors").insert(new_contractor).execute()

# UPDATE
supabase.table("contractors").update({"status": "approved"}).eq("id", 1).execute()

# DELETE
supabase.table("contractors").delete().eq("id", 1).execute()

# ФИЛЬТРАЦИЯ
data = supabase.table("contractors")\
    .select("*")\
    .eq("city", "Москва")\
    .eq("status", "approved")\
    .order("created_at", desc=True)\
    .limit(10)\
    .execute()

# ПОИСК
data = supabase.table("contractors")\
    .select("*")\
    .ilike("specialization", "%отделка%")\
    .execute()
```

## 🚨 РЕШЕНИЕ ПРОБЛЕМ

### Ошибка: "new row violates row-level security policy"

**Причина:** RLS блокирует операцию

**Решение:**
```sql
-- Временно отключить (для теста)
ALTER TABLE contractors DISABLE ROW LEVEL SECURITY;

-- Или добавить политику
CREATE POLICY "temp_allow_all"
ON contractors FOR ALL
USING (true);
```

### Ошибка: "relation contractors does not exist"

**Причина:** Таблица не создана

**Решение:** Выполните SQL скрипт создания таблицы

### Медленные запросы

**Решение:**
```sql
-- Анализ запроса
EXPLAIN ANALYZE
SELECT * FROM contractors WHERE city = 'Москва';

-- Добавление индекса если нужно
CREATE INDEX idx_custom ON contractors(column_name);

-- Вакуум (чистка)
VACUUM ANALYZE contractors;
```

### Превышен лимит подключений

**Причина:** Слишком много одновременных подключений

**Решение:**
1. Используйте connection pooling
2. Закрывайте неиспользуемые подключения
3. Апгрейд плана (Free: 60 подключений)

## 💡 BEST PRACTICES

1. **Всегда используйте индексы** для полей в WHERE
2. **Включайте RLS** для безопасности
3. **Делайте регулярные бэкапы** важных данных
4. **Используйте prepared statements** для защиты от SQL injection
5. **Мониторьте Query Performance** в Dashboard
6. **Не храните sensitive data** в открытом виде
7. **Используйте транзакции** для связанных операций

## 📈 МАСШТАБИРОВАНИЕ

### Оптимизация для большого количества данных

```sql
-- Партиционирование по дате (для > 1M записей)
CREATE TABLE contractors_2024 
PARTITION OF contractors 
FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

-- Архивирование старых данных
CREATE TABLE contractors_archive AS 
SELECT * FROM contractors WHERE created_at < '2023-01-01';

DELETE FROM contractors WHERE created_at < '2023-01-01';
```

### Кэширование

```python
import redis

redis_client = redis.Redis(host='localhost', port=6379)

def get_contractors_cached(city):
    cache_key = f"contractors:{city}"
    cached = redis_client.get(cache_key)
    
    if cached:
        return json.loads(cached)
    
    data = supabase.table("contractors")\
        .select("*")\
        .eq("city", city)\
        .eq("status", "approved")\
        .execute()
    
    redis_client.setex(cache_key, 3600, json.dumps(data.data))
    return data.data
```

## ✅ ЧЕКЛИСТ НАСТРОЙКИ

- [ ] Проект создан в Supabase
- [ ] Таблица contractors создана
- [ ] Индексы добавлены
- [ ] RLS настроен
- [ ] API ключи получены
- [ ] Тестовые данные добавлены
- [ ] Политики безопасности настроены
- [ ] Бэкапы настроены

---

**Готово! Ваша база данных настроена и готова к работе! 🎉**
