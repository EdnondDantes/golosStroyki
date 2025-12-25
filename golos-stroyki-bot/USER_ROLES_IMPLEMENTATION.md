# Реализация постоянного сохранения роли пользователя

## Обзор

Роль пользователя теперь сохраняется в отдельной таблице БД `user_roles` при первом выборе и не требует повторного выбора при перезапуске бота.

## Что было изменено

### 1. **Новая таблица БД: `user_roles`**

Таблица хранит映射:
- `telegram_id` → роль пользователя (один раз, навсегда)
- UNIQUE constraint на `telegram_id` (один пользователь = одна роль)

Возможные значения роли:
- `рабочий`
- `бригадир`
- `подрядчик/компания`
- `заказчик`
- `эксперт`
- `наблюдатель`

### 2. **Новые функции**

#### `saveUserRole(userId, role)` (строка 780)
Сохраняет или обновляет роль пользователя в БД.

**Возвращает:**
```javascript
{
  success: true/false,
  data: result,
  isNew: true/false  // true если это первое сохранение
}
```

**Логика:**
- Если роли нет → создает новую запись
- Если роль уже есть → обновляет существующую

#### `checkUserRole(userId)` - обновленная (строка 741)
Теперь ищет роль только в таблице `user_roles` вместо проверки трёх таблиц (contractors, orders, suppliers).

**Возвращает:** строка с названием роли или `null`

### 3. **Обновленный процесс выбора роли**

**Было:**
1. Пользователь нажимает кнопку роли
2. Роль сохраняется в памяти (`userStates[userId].selectedRole`)
3. Роль сохраняется в БД только при создании первой анкеты
4. При перезапуске бота роль потеряется

**Стало:**
1. Пользователь нажимает кнопку роли
2. **Роль СРАЗУ сохраняется в таблицу `user_roles`** ✅
3. Пользователь видит подтверждение
4. При перезапуске бота роль находится в БД и не требует повторного выбора

### 4. **Использование роли при сохранении анкет**

#### `finishForm()` (строка 3303)
```javascript
// НОВОЕ: Получаем роль из БД вместо временного хранилища
const userRole = await checkUserRole(userId);

const result = await saveContractorToDatabase({
  // ...
  role: userRole || null  // Получаем из user_roles таблицы
});
```

#### `finishOrderForm()` (строка 3358)
```javascript
// НОВОЕ: Получаем роль из БД вместо временного хранилища
const userRole = await checkUserRole(userId);

const result = await saveOrderToDatabase({
  // ...
  role: userRole || null  // Получаем из user_roles таблицы
});
```

## Инструкция по внедрению

### Шаг 1: Создать таблицу в Supabase

1. Откройте Supabase Dashboard → SQL Editor
2. Скопируйте содержимое файла `migrations_user_roles.sql`
3. Выполните SQL команды

Или используйте командную строку (если у вас установлен supabase-cli):
```bash
supabase migration up
```

### Шаг 2: Обновить код бота

Код уже обновлен в файле `bot.js`. Никакие дополнительные изменения не требуются.

### Шаг 3: Тестирование

1. **Первый запуск:**
   - Запустите бота: `/start`
   - Нажмите "В Базу"
   - Выберите роль → должно показаться подтверждение
   - Проверьте Supabase: в таблице `user_roles` должна быть запись с вашим `telegram_id`

2. **Перезапуск бота:**
   - Перезапустите бот или перезагрузите сервер
   - Запустите `/start` еще раз
   - Роль должна быть найдена в БД автоматически
   - Вы должны сразу перейти в главное меню БЕЗ экрана выбора роли

3. **Создание анкеты:**
   - Создайте анкету подрядчика или заявку
   - В БД (таблицы contractors/orders) должна сохраниться роль в поле `role`

## Преимущества новой архитектуры

| Аспект | Было | Стало |
|--------|------|-------|
| **Где хранится роль** | В памяти + одна из 3-х таблиц | В отдельной таблице `user_roles` |
| **Когда сохраняется** | При создании первой анкеты | Сразу при выборе |
| **При перезапуске бота** | Нужно выбрать роль заново | Роль находится в БД автоматически |
| **Поиск роли** | Проверка 3-х таблиц (contractors, orders, suppliers) | Один простой запрос к `user_roles` |
| **Надежность** | Роль может потеряться при краше бота | Всегда в БД |

## Обратная совместимость

Старые данные о ролях (сохраненные в таблицах contractors, orders, suppliers) **НЕ будут** автоматически мигрированы в новую таблицу `user_roles`.

**Рекомендация:** Если вам нужно мигрировать старые роли, выполните:

```sql
-- Мигрируем роли из contractors в user_roles
INSERT INTO user_roles (telegram_id, role)
SELECT DISTINCT telegram_id, role
FROM contractors
WHERE role IS NOT NULL
  AND telegram_id NOT IN (SELECT telegram_id FROM user_roles)
ON CONFLICT (telegram_id) DO NOTHING;

-- Мигрируем роли из orders в user_roles
INSERT INTO user_roles (telegram_id, role)
SELECT DISTINCT telegram_id, role
FROM orders
WHERE role IS NOT NULL
  AND telegram_id NOT IN (SELECT telegram_id FROM user_roles)
ON CONFLICT (telegram_id) DO NOTHING;

-- Мигрируем роли из suppliers в user_roles (если есть таблица)
INSERT INTO user_roles (telegram_id, role)
SELECT DISTINCT telegram_id, role
FROM suppliers
WHERE role IS NOT NULL
  AND telegram_id NOT IN (SELECT telegram_id FROM user_roles)
ON CONFLICT (telegram_id) DO NOTHING;
```

## Возможные ошибки и решения

### Ошибка 1: "relation "user_roles" does not exist"
**Решение:** Таблица `user_roles` не была создана. Выполните SQL из `migrations_user_roles.sql`.

### Ошибка 2: "duplicate key value violates unique constraint"
**Решение:** Пользователь пытался выбрать роль во второй раз. Это нормально — обновляется существующая запись.

### Ошибка 3: Роль не сохраняется при выборе
**Причины:**
- Таблица `user_roles` не существует
- SUPABASE_KEY не имеет прав на таблицу
- Ошибка в Supabase (check console logs)

**Решение:** Проверьте логи бота и Supabase Dashboard.

## Полезные SQL запросы

### Просмотр всех ролей пользователей
```sql
SELECT telegram_id, role, created_at, updated_at
FROM user_roles
ORDER BY created_at DESC;
```

### Изменить роль конкретного пользователя
```sql
UPDATE user_roles
SET role = 'заказчик'
WHERE telegram_id = YOUR_TELEGRAM_ID;
```

### Удалить роль пользователя (переселект при следующем входе)
```sql
DELETE FROM user_roles
WHERE telegram_id = YOUR_TELEGRAM_ID;
```

### Статистика ролей
```sql
SELECT role, COUNT(*) as count
FROM user_roles
GROUP BY role
ORDER BY count DESC;
```

## Файлы, которые были изменены

- ✅ `bot.js` - основной файл с логикой
- ✅ `migrations_user_roles.sql` - миграция БД (НОВЫЙ файл)
- ✅ `USER_ROLES_IMPLEMENTATION.md` - этот файл документации (НОВЫЙ файл)

## Дальнейшие улучшения (опционально)

1. **Позволить пользователю менять роль**
   - Добавить кнопку "Изменить роль" в меню
   - Обновить `user_roles` при выборе новой роли

2. **Управление ролями администратором**
   - Команды типа `/admin_set_role <telegram_id> <role>`

3. **История изменения ролей**
   - Добавить таблицу `user_role_history` для логирования всех изменений

4. **Аналитика по ролям**
   - Статистика по распределению ролей в сообществе
   - Анализ поведения пользователей разных ролей

## Вопросы?

Если есть проблемы или вопросы по реализации, проверьте:
1. Логи бота в консоли
2. Логи Supabase в Dashboard
3. Наличие таблицы `user_roles` в БД
4. Права доступа SUPABASE_KEY
