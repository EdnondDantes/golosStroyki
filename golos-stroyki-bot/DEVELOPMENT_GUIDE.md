# 💡 ПРИМЕРЫ И СОВЕТЫ ПО РАЗРАБОТКЕ

## 🎨 ФОРМАТИРОВАНИЕ СООБЩЕНИЙ В TELEGRAM

### HTML форматирование (используется в боте)

```python
# Жирный текст
"<b>Жирный текст</b>"

# Курсив
"<i>Курсивный текст</i>"

# Подчеркнутый
"<u>Подчеркнутый текст</u>"

# Зачеркнутый
"<s>Зачеркнутый текст</s>"

# Моноширинный (код)
"<code>код</code>"

# Блок кода
"<pre>блок кода</pre>"

# Ссылка
"<a href='https://example.com'>Текст ссылки</a>"

# Комбинирование
"<b>Жирный</b> и <i>курсив</i> <u>вместе</u>"
```

### Примеры из бота

```python
# Приветственное сообщение
await message.answer(
    f"👋 <b>Привет, {message.from_user.first_name}!</b>\n\n"
    "Ты в <i>Каталоге подрядчиков</i> проекта <b>Голос Стройки</b>.\n\n"
    "Здесь ты можешь:\n"
    "🔹 найти надёжного подрядчика\n"
    "🔹 посмотреть реальные профили\n"
    "🔹 получить контакт\n"
    "🔹 или добавить себя в каталог (если ты мастер/компания)\n\n"
    "<b>Выбери, что тебе нужно 👇</b>",
    parse_mode="HTML"
)

# Сообщение с подсказкой
await message.answer(
    "📝 <b>Шаг 1/8 — Имя / название компании</b>\n\n"
    "Как тебя зовут? Или название компании?\n\n"
    "🎤 <i>Можешь ответить текстом или голосовым сообщением</i>",
    parse_mode="HTML"
)

# Сообщение об успехе
await message.answer(
    "🎉 <b>Отлично!</b>\n\n"
    "Твоя анкета отправлена на модерацию.\n"
    "Когда карточка будет утверждена — мы пришлём уведомление.\n\n"
    "✨ <i>Обычно модерация занимает до 24 часов</i>",
    parse_mode="HTML"
)
```

## 🎯 FSM (Finite State Machine) - Машина состояний

### Зачем нужны состояния?

FSM позволяет боту "помнить", на каком этапе находится пользователь:
- Заполняет имя?
- Указывает город?
- Отправляет контакты?

### Создание состояний

```python
from aiogram.fsm.state import State, StatesGroup

class ContractorForm(StatesGroup):
    # Каждый шаг анкеты = отдельное состояние
    name = State()              # Шаг 1
    city = State()              # Шаг 2
    specialization = State()    # Шаг 3
    experience = State()        # Шаг 4
    description = State()       # Шаг 5
    price = State()             # Шаг 6
    portfolio = State()         # Шаг 7
    contacts = State()          # Шаг 8
```

### Работа с состояниями

```python
# Установить состояние
await state.set_state(ContractorForm.name)

# Сохранить данные в состояние
await state.update_data(name="Иван Петров")

# Получить все данные
data = await state.get_data()
print(data)  # {'name': 'Иван Петров'}

# Очистить состояние (завершить диалог)
await state.clear()
```

### Обработка по состояниям

```python
# Только когда пользователь в состоянии ContractorForm.name
@dp.message(ContractorForm.name, F.text)
async def process_name(message: Message, state: FSMContext):
    # Сохраняем ответ
    await state.update_data(name=message.text)
    
    # Переходим к следующему шагу
    await state.set_state(ContractorForm.city)
    await message.answer("В каком городе работаешь?")
```

## 🎤 РАБОТА С ГОЛОСОВЫМИ СООБЩЕНИЯМИ

### Обработка голоса

```python
@dp.message(ContractorForm.name, F.voice)
async def process_voice_name(message: Message, state: FSMContext):
    # 1. Получаем информацию о файле
    file = await bot.get_file(message.voice.file_id)
    
    # 2. Скачиваем файл
    file_path = f"/tmp/voice_{message.from_user.id}.ogg"
    await bot.download_file(file.file_path, file_path)
    
    # 3. Распознаём речь
    recognized_text = await recognize_speech(file_path)
    
    # 4. Сохраняем результат
    if recognized_text:
        await state.update_data(name=recognized_text)
        await message.answer(f"✅ Записано: {recognized_text}")
    else:
        await message.answer("❌ Не удалось распознать. Попробуй ещё раз.")
    
    # 5. Удаляем временный файл
    if os.path.exists(file_path):
        os.remove(file_path)
```

### Интеграция с Yandex SpeechKit

```python
import aiohttp

async def recognize_speech(file_path: str) -> str:
    url = "https://stt.api.cloud.yandex.net/speech/v1/stt:recognize"
    
    headers = {
        "Authorization": f"Api-Key {YANDEX_API_KEY}",
    }
    
    params = {
        "lang": "ru-RU",
        "folderId": YANDEX_FOLDER_ID,
        "format": "oggopus",  # Формат Telegram voice
    }
    
    async with aiohttp.ClientSession() as session:
        with open(file_path, 'rb') as f:
            data = f.read()
        
        async with session.post(url, headers=headers, params=params, data=data) as response:
            if response.status == 200:
                result = await response.json()
                return result.get('result', '')
            else:
                return ""
```

## ⌨️ INLINE КЛАВИАТУРЫ

### Создание кнопок

```python
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton

# Простая кнопка
keyboard = InlineKeyboardMarkup(inline_keyboard=[
    [InlineKeyboardButton(text="Нажми меня", callback_data="button_clicked")]
])

# Несколько кнопок в ряд
keyboard = InlineKeyboardMarkup(inline_keyboard=[
    [
        InlineKeyboardButton(text="Да", callback_data="yes"),
        InlineKeyboardButton(text="Нет", callback_data="no")
    ]
])

# Кнопки друг под другом
keyboard = InlineKeyboardMarkup(inline_keyboard=[
    [InlineKeyboardButton(text="Вариант 1", callback_data="opt1")],
    [InlineKeyboardButton(text="Вариант 2", callback_data="opt2")],
    [InlineKeyboardButton(text="Вариант 3", callback_data="opt3")]
])

# Кнопка-ссылка
keyboard = InlineKeyboardMarkup(inline_keyboard=[
    [InlineKeyboardButton(text="Перейти на сайт", url="https://example.com")]
])
```

### Обработка нажатий

```python
@dp.callback_query(F.data == "button_clicked")
async def button_handler(callback: CallbackQuery):
    # Ответ пользователю (всплывающее уведомление)
    await callback.answer("Кнопка нажата!")
    
    # Или с предупреждением
    await callback.answer("Внимание!", show_alert=True)
    
    # Редактирование сообщения
    await callback.message.edit_text("Текст изменён после нажатия")
    
    # Или отправка нового сообщения
    await callback.message.answer("Новое сообщение")
```

## 📊 РАБОТА С SUPABASE

### Подключение

```python
from supabase import create_client, Client

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
```

### INSERT - Добавление данных

```python
# Простой insert
data = {
    "user_id": 123456789,
    "name": "Иван Петров",
    "city": "Москва"
}
result = supabase.table("contractors").insert(data).execute()

# Insert с возвратом добавленной записи
result = supabase.table("contractors").insert(data).execute()
inserted_id = result.data[0]['id']
print(f"Добавлена запись с ID: {inserted_id}")
```

### SELECT - Получение данных

```python
# Все записи
data = supabase.table("contractors").select("*").execute()

# С фильтром
data = supabase.table("contractors")\
    .select("*")\
    .eq("city", "Москва")\
    .execute()

# Несколько фильтров
data = supabase.table("contractors")\
    .select("*")\
    .eq("city", "Москва")\
    .eq("status", "approved")\
    .execute()

# С сортировкой
data = supabase.table("contractors")\
    .select("*")\
    .order("created_at", desc=True)\
    .limit(10)\
    .execute()

# С поиском (LIKE)
data = supabase.table("contractors")\
    .select("*")\
    .ilike("specialization", "%отделка%")\
    .execute()
```

### UPDATE - Обновление данных

```python
# Обновление по ID
supabase.table("contractors")\
    .update({"status": "approved"})\
    .eq("id", 1)\
    .execute()

# Обновление нескольких полей
supabase.table("contractors")\
    .update({
        "status": "approved",
        "updated_at": datetime.utcnow().isoformat()
    })\
    .eq("id", 1)\
    .execute()
```

### DELETE - Удаление данных

```python
# Удаление по ID
supabase.table("contractors")\
    .delete()\
    .eq("id", 1)\
    .execute()

# Удаление с условием
supabase.table("contractors")\
    .delete()\
    .eq("status", "rejected")\
    .lt("created_at", "2023-01-01")\
    .execute()
```

### Обработка ошибок

```python
try:
    result = supabase.table("contractors").insert(data).execute()
    print("Успешно сохранено!")
except Exception as e:
    print(f"Ошибка: {e}")
    # Логирование или уведомление пользователя
```

## 🔍 ПРОВЕРКА ПОДПИСКИ НА КАНАЛ

### Функция проверки

```python
async def check_subscription(user_id: int) -> bool:
    try:
        # Получаем информацию о пользователе в канале
        member = await bot.get_chat_member(
            chat_id=CHANNEL_USERNAME,  # @your_channel
            user_id=user_id
        )
        
        # Проверяем статус
        # member, administrator, creator - подписан
        # left, kicked - не подписан
        return member.status in ['member', 'administrator', 'creator']
    except Exception as e:
        logger.error(f"Ошибка проверки подписки: {e}")
        return False
```

### Использование

```python
@dp.message(CommandStart())
async def cmd_start(message: Message):
    user_id = message.from_user.id
    
    if not await check_subscription(user_id):
        await message.answer(
            "Сначала подпишись на канал!",
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(
                    text="Подписаться",
                    url=f"https://t.me/{CHANNEL_USERNAME.replace('@', '')}"
                )],
                [InlineKeyboardButton(
                    text="✅ Я подписался",
                    callback_data="check_sub"
                )]
            ])
        )
        return
    
    # Продолжаем работу...
```

## 📝 ЛОГИРОВАНИЕ

### Настройка

```python
import logging

# Базовая настройка
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)
```

### Использование

```python
# Информационное сообщение
logger.info("Бот запущен")
logger.info(f"Пользователь {user_id} начал заполнение анкеты")

# Предупреждение
logger.warning("Подозрительная активность")

# Ошибка
logger.error(f"Ошибка при сохранении в Supabase: {e}")

# Критическая ошибка
logger.critical("Не удалось подключиться к базе данных!")

# Debug (только при level=logging.DEBUG)
logger.debug(f"Данные анкеты: {data}")
```

### Логирование в файл

```python
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("bot.log"),
        logging.StreamHandler()  # И в консоль тоже
    ]
)
```

## 🔄 АСИНХРОННОСТЬ

### Что такое async/await?

```python
# Синхронная функция (блокирует выполнение)
def download_file():
    time.sleep(5)  # Ждём 5 секунд
    return "file.txt"

# Асинхронная функция (не блокирует)
async def download_file_async():
    await asyncio.sleep(5)  # Другие задачи могут выполняться
    return "file.txt"
```

### Параллельное выполнение

```python
# Последовательно (долго)
await task1()
await task2()
await task3()

# Параллельно (быстро)
await asyncio.gather(
    task1(),
    task2(),
    task3()
)
```

### В боте

```python
# Отправить несколько сообщений параллельно
await asyncio.gather(
    message.answer("Сообщение 1"),
    message.answer("Сообщение 2"),
    message.answer("Сообщение 3")
)
```

## 🎛️ ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ

### Зачем нужны?

- 🔐 Безопасность (не храним токены в коде)
- 🔄 Гибкость (легко менять настройки)
- 🌍 Разные окружения (dev, prod)

### Работа с .env

```python
from dotenv import load_dotenv
import os

# Загрузить переменные из .env
load_dotenv()

# Получить переменную
BOT_TOKEN = os.getenv("BOT_TOKEN")

# С дефолтным значением
CHANNEL = os.getenv("CHANNEL_USERNAME", "@default_channel")

# Обязательная переменная (с проверкой)
BOT_TOKEN = os.getenv("BOT_TOKEN")
if not BOT_TOKEN:
    raise ValueError("BOT_TOKEN не установлен!")
```

### Пример .env

```env
# Комментарий
BOT_TOKEN=123456789:ABCdefGHI
SUPABASE_URL=https://abc.supabase.co

# Можно использовать переменные
BASE_URL=https://api.example.com
API_ENDPOINT=${BASE_URL}/v1/data
```

## 🐛 ОТЛАДКА

### Вывод переменных

```python
# Просто print
print(f"User ID: {user_id}")

# Красивый вывод структур
import pprint
pprint.pprint(data)

# В логи
logger.debug(f"State data: {await state.get_data()}")
```

### Точки останова (breakpoints)

```python
# Python debugger
import pdb

@dp.message(F.text)
async def handler(message: Message):
    pdb.set_trace()  # Выполнение остановится здесь
    # Можно смотреть переменные, выполнять код
    print(message.text)
```

### Try-except для отлавливания ошибок

```python
try:
    result = supabase.table("contractors").insert(data).execute()
except Exception as e:
    logger.error(f"Ошибка: {e}")
    logger.error(f"Данные: {data}")
    await message.answer("Произошла ошибка. Попробуй позже.")
```

## 🚀 ОПТИМИЗАЦИЯ

### Кэширование результатов

```python
from functools import lru_cache

@lru_cache(maxsize=128)
def get_city_list():
    # Эта функция выполнится только один раз
    return ["Москва", "Санкт-Петербург", "Казань"]
```

### Батчинг (пакетная обработка)

```python
# Плохо - много запросов
for item in items:
    supabase.table("contractors").insert(item).execute()

# Хорошо - один запрос
supabase.table("contractors").insert(items).execute()
```

### Асинхронные операции

```python
# Используйте асинхронные библиотеки
import aiohttp  # вместо requests
import asyncpg  # вместо psycopg2
```

## 📦 ПОЛЕЗНЫЕ БИБЛИОТЕКИ

```python
# Работа с датами
from datetime import datetime, timedelta
now = datetime.now()
tomorrow = now + timedelta(days=1)

# Валидация данных
from pydantic import BaseModel, validator

class Contractor(BaseModel):
    name: str
    city: str
    experience: int
    
    @validator('experience')
    def validate_experience(cls, v):
        if v < 0 or v > 50:
            raise ValueError('Опыт должен быть от 0 до 50 лет')
        return v

# Работа с изображениями
from PIL import Image
img = Image.open("photo.jpg")
img.resize((800, 600)).save("photo_resized.jpg")

# Работа с Excel
import pandas as pd
df = pd.read_excel("contractors.xlsx")
df.to_csv("contractors.csv")
```

## ✅ ЧЕКЛИСТ РАЗРАБОТЧИКА

- [ ] Код читаемый и понятный
- [ ] Есть обработка ошибок (try-except)
- [ ] Настроено логирование
- [ ] Секретные данные в .env
- [ ] Добавлены комментарии к сложным местам
- [ ] Протестированы все сценарии
- [ ] Проверена работа на разных устройствах
- [ ] Код отформатирован (black, flake8)
- [ ] Нет дублирования кода
- [ ] Используется async где возможно

---

**Удачи в разработке! 🚀**
