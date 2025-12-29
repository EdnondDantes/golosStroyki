require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { CATEGORIES, CATEGORY_TO_WORK_AREA } = require('./categories'); // Этап 5: AI-определение категории

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID; // например: @golos_stroyki
const COMMUNITY_CHANNEL_NAME = process.env.COMMUNITY_CHANNEL_NAME || 'golos_stroyki'; // имя канала для ссылок на портфолио
const BOT_USERNAME = process.env.BOT_USERNAME; // username бота для ссылок в постах канала
const CONTRACTORS_THREAD_ID = process.env.CONTRACTORS_THREAD_ID; // ID топика для анкет специалистов
const ORDERS_THREAD_ID = process.env.ORDERS_THREAD_ID; // ID топика для заявок

// Инициализация
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Тест соединения с Supabase
(async () => {
  try {
    const { data, error } = await supabase.from('contractors').select('count');
    if (error) {
      console.error('❌ Ошибка подключения к Supabase:', error);
    } else {
      console.log('✅ Supabase подключен успешно');
    }
  } catch (err) {
    console.error('❌ Критическая ошибка Supabase:', err.message);
  }
})();

// Проверка прав бота в канале при старте
(async () => {
  try {
    // Получаем информацию о боте
    const me = await bot.getMe();
    console.log(`🤖 Бот запущен: @${me.username} (ID: ${me.id})`);

    // Проверяем права в канале
    if (CHANNEL_ID) {
      try {
        const member = await bot.getChatMember(CHANNEL_ID, me.id);

        if (member.status === 'administrator' || member.status === 'creator') {
          if (member.can_post_messages) {
            console.log('✅ Канал подключен, публикация работает');
          } else {
            console.log('⚠️ Бот администратор, но нет прав на публикацию');
            console.log('   Дайте боту право "Публикация сообщений" в настройках канала');
          }
        } else {
          console.log('❌ Бот не является администратором канала');
          console.log('   Добавьте бота в администраторы канала:', CHANNEL_ID);
        }
      } catch (channelError) {
        console.error('❌ Не удалось подключиться к каналу:', channelError.message);
        console.log('   Проверьте CHANNEL_ID в файле .env');
      }
    } else {
      console.log('⚠️ CHANNEL_ID не указан в .env - публикация в канал отключена');
    }
  } catch (error) {
    console.error('❌ Ошибка при проверке прав бота:', error.message);
  }
})();

// Хранилище состояний пользователей
const userStates = {};

// Хранилище состояний поиска
const searchStates = {};

// Хранилище состояний жалоб
const complaintStates = {};

// Хранилище ID сообщений для редактирования (живые сообщения)
const liveMessages = {};

// Хранилище deep link параметров для новых пользователей
const pendingDeepLinks = {};

// ==================== УТИЛИТЫ ====================

// Проверка, можно ли удалять сообщения в этом чате
function canDeleteInChat(chatId) {
  // Преобразуем chatId в строку для сравнения
  const chatIdStr = String(chatId);
  const channelIdStr = String(CHANNEL_ID);

  // Запрещаем удаление в канале сообщества
  if (CHANNEL_ID && (chatIdStr === channelIdStr || chatIdStr === channelIdStr.replace('@', ''))) {
    return false;
  }

  // Запрещаем удаление в групповых чатах (chatId < 0 означает группу)
  if (chatId < 0) {
    return false;
  }

  // Разрешаем удаление только в личных чатах с пользователями
  return true;
}

// Безопасная обертка для удаления сообщений
async function safeDeleteMessage(chatId, messageId) {
  if (!canDeleteInChat(chatId)) {
    return; // Не удаляем сообщения в канале или группах
  }

  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (error) {
    // Игнорируем ошибку если сообщение уже удалено
    if (!error.message.includes('message to delete not found')) {
      console.error('Ошибка удаления сообщения:', error.message);
    }
  }
}

// Функция для автоудаления служебных сообщений
async function deleteMessageAfterDelay(chatId, messageId, delay = 7000) {
  // Проверяем, можно ли удалять сообщения в этом чате
  if (!canDeleteInChat(chatId)) {
    return; // Не удаляем сообщения в канале или группах
  }

  setTimeout(async () => {
    try {
      await safeDeleteMessage(chatId, messageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
      if (!error.message.includes('message to delete not found')) {
        console.error('Ошибка удаления сообщения:', error.message);
      }
    }
  }, delay);
}

// Функция для отправки сообщения шага анкеты с удалением предыдущего
async function sendOrEditStepMessage(chatId, userId, text, keyboard) {
  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    // Проверяем, можно ли удалять сообщения в этом чате
    if (canDeleteInChat(chatId)) {
      try {
        await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
      } catch (error) {
        // Игнорируем ошибку если сообщение уже удалено
      }
    }
  }

  // Отправляем новое сообщение
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    ...keyboard
  });

  // Сохраняем ID нового сообщения
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Валидация данных
function validateName(text) {
  if (!text || text.trim().length < 2) {
    return { valid: false, message: '❌ Имя слишком короткое. Минимум 2 символа.' };
  }
  if (text.length > 100) {
    return { valid: false, message: '❌ Имя слишком длинное. Максимум 100 символов.' };
  }
  return { valid: true };
}

function validateCity(text) {
  if (!text || text.trim().length < 2) {
    return { valid: false, message: '❌ Название города слишком короткое. Минимум 2 символа.' };
  }
  if (text.length > 50) {
    return { valid: false, message: '❌ Название города слишком длинное. Максимум 50 символов.' };
  }
  return { valid: true };
}

function validateSpecialization(text) {
  if (!text || text.trim().length < 5) {
    return { valid: false, message: '❌ Специализация слишком короткая. Опишите подробнее (минимум 5 символов).' };
  }
  if (text.length > 300) {
    return { valid: false, message: '❌ Специализация слишком длинная. Максимум 300 символов.' };
  }
  return { valid: true };
}

function validateExperience(text) {
  if (!text || text.trim().length < 1) {
    return { valid: false, message: '❌ Укажите опыт работы.' };
  }
  if (text.length > 50) {
    return { valid: false, message: '❌ Слишком длинный текст. Максимум 50 символов.' };
  }
  return { valid: true };
}

function validateDescription(text) {
  if (!text || text.trim().length < 10) {
    return { valid: false, message: '❌ Описание слишком короткое. Напишите подробнее (минимум 10 символов).' };
  }
  if (text.length > 500) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 500 символов.' };
  }
  return { valid: true };
}

function validatePrice(text) {
  if (!text || text.trim().length < 2) {
    return { valid: false, message: '❌ Укажите стоимость услуг.' };
  }
  if (text.length > 100) {
    return { valid: false, message: '❌ Описание цены слишком длинное. Максимум 100 символов.' };
  }
  return { valid: true };
}

function validatePortfolio(text) {
  if (!text || text.trim().length < 3) {
    return { valid: false, message: '❌ Укажите ссылку на портфолио или напишите "нет".' };
  }
  if (text.length > 200) {
    return { valid: false, message: '❌ Ссылка слишком длинная. Максимум 200 символов.' };
  }
  // Проверка, что если это ссылка, то она начинается с http/https/@/t.me
  const urlPattern = /^(https?:\/\/|@|t\.me)/i;
  const isLink = urlPattern.test(text.trim());
  const isNoPortfolio = /^(нет|no|none|н\/д)$/i.test(text.trim());

  if (!isLink && !isNoPortfolio && text.trim().length > 10) {
    return { valid: false, message: '❌ Укажите корректную ссылку (начинается с http://, https://, @, или t.me) или напишите "нет".' };
  }
  return { valid: true };
}

function validateContact(text) {
  if (!text || text.trim().length < 3) {
    return { valid: false, message: '❌ Укажите номер телефона для связи.' };
  }
  if (text.length > 100) {
    return { valid: false, message: '❌ Номер телефона слишком длинный. Максимум 100 символов.' };
  }

  // Удаляем пробелы, скобки, дефисы для проверки
  const cleanNumber = text.trim().replace(/[\s\-\(\)]/g, '');

  // Проверка формата: должен начинаться с + или цифры, содержать только цифры после очистки
  const phonePattern = /^\+?\d{10,15}$/;

  if (!phonePattern.test(cleanNumber)) {
    return { valid: false, message: '❌ Некорректный формат номера телефона. Используйте формат: +79123456789 или 89123456789' };
  }

  return { valid: true };
}

function validateCitizenship(text) {
  if (!text || text.trim().length < 2) {
    return { valid: false, message: '❌ Укажите гражданство.' };
  }
  if (text.length > 50) {
    return { valid: false, message: '❌ Название страны слишком длинное. Максимум 50 символов.' };
  }
  return { valid: true };
}

function validatePhoneNumber(text) {
  if (!text || text.trim().length < 5) {
    return { valid: false, message: '❌ Укажите номер телефона.' };
  }

  // Убираем все символы кроме цифр и +
  const cleanNumber = text.replace(/[\s\-\(\)]/g, '');

  // Проверка на корректный формат номера телефона
  const phonePattern = /^\+?[\d]{7,15}$/;

  if (!phonePattern.test(cleanNumber)) {
    return { valid: false, message: '❌ Некорректный формат номера телефона. Пример: +79123456789 или 89123456789' };
  }

  return { valid: true };
}

function validateTeamSize(text) {
  if (!text || text.trim().length < 1) {
    return { valid: false, message: '❌ Укажите количество человек в команде.' };
  }
  if (text.length > 50) {
    return { valid: false, message: '❌ Слишком длинный текст. Максимум 50 символов.' };
  }
  return { valid: true };
}

function validateWorkFormat(text) {
  if (!text || text.trim().length < 2) {
    return { valid: false, message: '❌ Укажите формат работы.' };
  }
  if (text.length > 100) {
    return { valid: false, message: '❌ Слишком длинный текст. Максимум 100 символов.' };
  }
  return { valid: true };
}

function validateObjectsWorked(text) {
  if (!text || text.trim().length < 10) {
    return { valid: false, message: '❌ Опишите подробнее объекты, на которых работали (минимум 10 символов).' };
  }
  if (text.length > 500) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 500 символов.' };
  }
  return { valid: true };
}

function validateWorkVolume(text) {
  if (!text || text.trim().length < 5) {
    return { valid: false, message: '❌ Укажите объём работ, который можете выполнить (минимум 5 символов).' };
  }
  if (text.length > 300) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 300 символов.' };
  }
  return { valid: true };
}

function validateDocumentsForm(text) {
  if (!text || text.trim().length < 2) {
    return { valid: false, message: '❌ Укажите форму работы/документы.' };
  }
  if (text.length > 100) {
    return { valid: false, message: '❌ Слишком длинный текст. Максимум 100 символов.' };
  }
  return { valid: true };
}

function validatePaymentConditions(text) {
  if (!text || text.trim().length < 5) {
    return { valid: false, message: '❌ Укажите условия оплаты (минимум 5 символов).' };
  }
  if (text.length > 200) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 200 символов.' };
  }
  return { valid: true };
}

// Валидация для полей orders (объекты/заказы)
function validateCityLocation(text) {
  if (!text || text.trim().length < 3) {
    return { valid: false, message: '❌ Укажите город и локацию объекта.' };
  }
  if (text.length > 200) {
    return { valid: false, message: '❌ Слишком длинный текст. Максимум 200 символов.' };
  }
  return { valid: true };
}

function validateWorkType(text) {
  if (!text || text.trim().length < 5) {
    return { valid: false, message: '❌ Опишите какие работы нужны (минимум 5 символов).' };
  }
  if (text.length > 300) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 300 символов.' };
  }
  return { valid: true };
}

function validateVolumeTimeline(text) {
  if (!text || text.trim().length < 10) {
    return { valid: false, message: '❌ Укажите объём и сроки (минимум 10 символов).' };
  }
  if (text.length > 400) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 400 символов.' };
  }
  return { valid: true };
}

function validateExecutorRequirements(text) {
  if (!text || text.trim().length < 5) {
    return { valid: false, message: '❌ Укажите требования к исполнителю (минимум 5 символов).' };
  }
  if (text.length > 300) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 300 символов.' };
  }
  return { valid: true };
}

// Валидация для полей suppliers (поставщики)
function validateCompanyName(text) {
  if (!text || text.trim().length < 2) {
    return { valid: false, message: '❌ Имя или название компании слишком короткое (минимум 2 символа).' };
  }
  if (text.length > 100) {
    return { valid: false, message: '❌ Имя или название слишком длинное. Максимум 100 символов.' };
  }
  return { valid: true };
}

// Вычисление даты истечения срока актуальности заявки
function calculateExpirationDate(validityPeriod) {
  if (!validityPeriod) return null;

  // Извлекаем число дней из текста
  const match = validityPeriod.match(/(\d+)/);
  if (!match) return null;

  const days = parseInt(match[1]);
  const expirationDate = new Date();
  expirationDate.setDate(expirationDate.getDate() + days);

  return expirationDate.toISOString();
}

// Проверка подписки на канал
async function checkSubscription(userId) {
  try {
    const member = await bot.getChatMember(CHANNEL_ID, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (error) {
    // Если бот не администратор канала (CHAT_ADMIN_REQUIRED), пропускаем проверку
    if (error.response && error.response.body && error.response.body.description.includes('CHAT_ADMIN_REQUIRED')) {
      console.warn('⚠️ Бот не является администратором канала. Проверка подписки отключена.');
      console.warn('Добавьте бота администратором канала для включения проверки подписки.');
      return true; // Временно пропускаем всех пользователей
    }
    console.error('Ошибка проверки подписки:', error.message || error);
    return false;
  }
}

// Распознавание голоса через Yandex SpeechKit
async function recognizeVoice(fileId) {
  try {
    // Получаем файл от Telegram
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Скачиваем файл
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(response.data);

    // Конвертируем в OGG если нужно (Telegram отправляет голосовые в OGG)
    // Отправляем в Yandex SpeechKit
    const recognitionResponse = await axios.post(
      'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize',
      audioBuffer,
      {
        headers: {
          'Authorization': `Api-Key ${YANDEX_API_KEY}`,
          'Content-Type': 'audio/ogg'
        },
        params: {
          lang: 'ru-RU',
          folderId: YANDEX_FOLDER_ID
        }
      }
    );

    return recognitionResponse.data.result || null;
  } catch (error) {
    console.error('Ошибка распознавания голоса:', error);
    return null;
  }
}

// Обработка текста через Deepseek AI для исправления опечаток и структурирования
async function processTextWithDeepseek(text, fieldType = 'general') {
  try {
    // Если API ключ не настроен, возвращаем текст как есть
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
      return text;
    }

    // Определяем промпт в зависимости от типа поля
    let systemPrompt = '';

    if (fieldType === 'specialization') {
      systemPrompt = `Ты помощник, который исправляет опечатки и КРАТКО формулирует специализацию подрядчика.
Твоя задача:
1. Исправить все орфографические и грамматические ошибки
2. МАКСИМАЛЬНО СОКРАТИТЬ текст, убрать воду и лишние слова
3. Оставить ТОЛЬКО суть - список специализаций через запятую
4. НЕ добавлять новые слова и фразы
5. Вернуть ТОЛЬКО исправленный текст, без комментариев и пояснений

ВАЖНО: Результат должен быть КОРОЧЕ оригинала!

Пример:
Вход: "малярка отделачные работи укладка плитке"
Выход: "Малярные работы, отделка, плитка"`;
    } else if (fieldType === 'description') {
      systemPrompt = `Ты помощник, который исправляет опечатки и КРАТКО формулирует описание услуг.
Твоя задача:
1. Исправить все орфографические и грамматические ошибки
2. МАКСИМАЛЬНО СОКРАТИТЬ текст, убрать воду и повторы
3. Оставить только конкретные факты
4. НЕ добавлять новые фразы типа "гарантия качества", если их не было в оригинале
5. Максимум 1-2 коротких предложения
6. Вернуть ТОЛЬКО исправленный текст, без комментариев и пояснений

ВАЖНО: Результат должен быть КОРОЧЕ оригинала!

Пример:
Вход: "делаю ремонты квартир офисов всякие малярку плитку всё качественно недорого быстро"
Выход: "Ремонт квартир и офисов. Малярка, плитка."`;
    } else {
      systemPrompt = `Ты помощник, который исправляет опечатки и СОКРАЩАЕТ текст.
Твоя задача:
1. Исправить все орфографические и грамматические ошибки
2. УБРАТЬ лишнюю информацию и воду
3. СОКРАТИТЬ текст до минимума
4. Вернуть ТОЛЬКО исправленный текст, без комментариев и пояснений

ВАЖНО: Результат должен быть КОРОЧЕ оригинала!`;
    }

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.2,
        max_tokens: 150
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const processedText = response.data.choices[0].message.content.trim();
    return processedText || text;

  } catch (error) {
    console.error('Ошибка обработки текста через Deepseek:', error.response?.data || error.message);
    // В случае ошибки возвращаем оригинальный текст
    return text;
  }
}

// Обработка названия города через Deepseek AI для исправления опечаток и нормализации
async function processCityWithDeepseek(text) {
  try {
    // Если API ключ не настроен, возвращаем текст как есть
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
      return text;
    }

    const systemPrompt = `Ты помощник, который исправляет и нормализует названия городов России, СНГ и мира.

Твоя задача:
1. Исправить опечатки в названии города
2. Привести к правильному написанию (например: "питер" → "Санкт-Петербург", "мск" → "Москва", "минск" → "Минск")
3. Если это НЕ название города или непонятный текст - верни слово "UNKNOWN"
4. Вернуть ТОЛЬКО название города без дополнительных слов
5. Принимаются города из любых стран, включая Россию, Беларусь, Казахстан, Украину и другие

Примеры:
Вход: "маскав" → Выход: "Москва"
Вход: "питер" → Выход: "Санкт-Петербург"
Вход: "мск" → Выход: "Москва"
Вход: "спб" → Выход: "Санкт-Петербург"
Вход: "Новосибирскк" → Выход: "Новосибирск"
Вход: "минск" → Выход: "Минск"
Вход: "киев" → Выход: "Киев"
Вход: "алматы" → Выход: "Алматы"
Вход: "asdfgh" → Выход: "UNKNOWN"
Вход: "123" → Выход: "UNKNOWN"`;

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: text
          }
        ],
        temperature: 0.1,
        max_tokens: 50
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const processedCity = response.data.choices[0].message.content.trim();

    // Если AI не смог распознать город
    if (processedCity === 'UNKNOWN' || !processedCity) {
      return null;
    }

    return processedCity;

  } catch (error) {
    console.error('Ошибка обработки города через Deepseek:', error.response?.data || error.message);
    // В случае ошибки возвращаем оригинальный текст
    return text;
  }
}

// Функция определения области работ по категории
function getWorkAreaByCategory(category) {
  if (!category) return null;
  return CATEGORY_TO_WORK_AREA[category] || null;
}

// Функция определения эмодзи по роли
function getRoleEmoji(role) {
  if (!role) return '';

  const roleEmojiMap = {
    'рабочий': '👷',
    'бригадир': '👷‍♂️',
    'подрядчик': '🧱',
    'заказчик': '🏗',
    'эксперт': '🧠',
    'наблюдатель': '👁'
  };

  const roleLower = role.toLowerCase().trim();
  const emoji = roleEmojiMap[roleLower] || '🧠';

  return `\n${emoji} [${role}]`;
}

// Функция преобразования формата работы из родительного падежа в именительный
function normalizeWorkFormat(workFormat) {
  const formatMap = {
    'Специалиста': 'Специалист',
    'Бригаду': 'Бригада',
    'Компанию/подрядчика': 'Компания',
    'Компания/подрядчик': 'Компания',
    // Также поддерживаем именительный падеж (если уже передан)
    'Специалист': 'Специалист',
    'Бригада': 'Бригада',
    'Компания': 'Компания'
  };
  return formatMap[workFormat] || workFormat;
}

// Этап 5: AI-определение категории из списка 275 позиций
async function determineCategoryWithAI(text, workFormat) {
  try {
    // Если API ключ не настроен, возвращаем null
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
      console.log('⚠️ DEEPSEEK_API_KEY не настроен, пропускаем определение категории');
      return null;
    }

    // Нормализуем формат работы (из родительного падежа в именительный)
    const normalizedFormat = normalizeWorkFormat(workFormat);

    // Определяем список категорий в зависимости от формата работы
    let categoryList = [];
    if (normalizedFormat === 'Специалист') {
      categoryList = CATEGORIES.specialists;
    } else if (normalizedFormat === 'Бригада') {
      categoryList = CATEGORIES.brigades;
    } else if (normalizedFormat === 'Компания') {
      categoryList = CATEGORIES.companies;
    } else if (workFormat === 'any') {
      // Для заявок используем все категории
      categoryList = [...CATEGORIES.specialists, ...CATEGORIES.brigades, ...CATEGORIES.companies];
    } else {
      console.log(`⚠️ Неизвестный формат работы: ${workFormat} (normalized: ${normalizedFormat})`);
      return null;
    }

    // Формируем промпт для AI
    const systemPrompt = `Ты помощник для определения категории специалиста из строительной отрасли.

Твоя задача:
1. Прочитай описание специализации от пользователя
2. Выбери ОДНУ наиболее подходящую категорию из списка ниже
3. Верни ТОЛЬКО название категории, без пояснений и дополнительного текста

Список категорий:
${categoryList.join('\n')}

ВАЖНО:
- Выбирай ТОЛЬКО из списка выше
- Если не можешь точно определить - верни слово "UNKNOWN"
- НЕ придумывай новые категории`;

    const userPrompt = `Описание специализации: "${text}"`;

    // Отправляем запрос в Deepseek
    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        temperature: 0.1, // Низкая температура для точности
        max_tokens: 50
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const aiResponse = response.data.choices[0].message.content.trim();

    // Проверяем, что ответ содержит одну из категорий из списка
    let category = null;
    if (aiResponse && aiResponse !== 'UNKNOWN') {
      // Ищем точное совпадение с одной из категорий
      const foundCategory = categoryList.find(cat =>
        aiResponse.includes(cat) || cat.includes(aiResponse)
      );
      if (foundCategory) {
        category = foundCategory;
      }
    }

    // Логирование для отладки
    console.log(`🔍 Определение категории:`);
    console.log(`   Текст: "${text}"`);
    console.log(`   Формат (оригинал): ${workFormat}`);
    console.log(`   Формат (нормализован): ${normalizedFormat}`);
    console.log(`   AI ответ: "${aiResponse}"`);
    console.log(`   Результат: ${category || 'НЕ ОПРЕДЕЛЕНО'}`);

    return category;

  } catch (error) {
    console.error('❌ Ошибка определения категории через Deepseek:', error.response?.data || error.message);
    return null;
  }
}

// Генерация хука для анкеты специалиста через Deepseek AI
async function generateContractorHook(contractorData) {
  try {
    // Если API ключ не настроен, возвращаем null
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
      console.log('⚠️ DEEPSEEK_API_KEY не настроен, пропускаем генерацию хука');
      return null;
    }

    // Формируем входные данные для AI
    const inputData = {
      specialization: contractorData.specialization || '',
      experience: contractorData.experience || '',
      advantages: contractorData.professionalAdvantages || '',
      objectsWorked: contractorData.objectsWorked || '',
      workFormat: contractorData.workFormat || '',
      readyForTrips: contractorData.readyForTrips || false
    };

    const systemPrompt = `Ты создаешь короткие цепляющие хуки (заголовки) для анкет строителей и подрядчиков.

ЗАДАЧА: Создай хук по формуле [Специализация] + [уникальное отличие] — [польза для клиента]

ПРАВИЛА:
1. Максимум 60 символов
2. БЕЗ штампов типа "профессионал", "качество", "опыт работы"
3. Конкретика, а не общие слова
4. Если нет явных уникальных преимуществ или опыт меньше 1 года — верни "SKIP"
5. Используй конкретные факты из данных (оборудование, сертификаты, специализация)

ПРИМЕРЫ ХОРОШИХ ХУКОВ:
✅ "Электрик с допуском СРО — работаем с промобъектами"
✅ "Плиточник 10 лет — мозаика и сложные узоры"
✅ "Геодезист со своим оборудованием — без ожиданий"
✅ "Кровельщик — гарантия 5 лет на сложные кровли"

ПРИМЕРЫ ПЛОХИХ ХУКОВ:
❌ "Опытный электрик с большим стажем"
❌ "Качественная укладка плитки"
❌ "Профессиональный подход к работе"

Верни ТОЛЬКО текст хука или слово "SKIP"`;

    const userPrompt = `Данные специалиста:
Формат работы: ${inputData.workFormat}
Специализация: ${inputData.specialization}
Опыт: ${inputData.experience}
Объекты: ${inputData.objectsWorked}
Преимущества: ${inputData.advantages || 'не указаны'}
Готов к командировкам: ${inputData.readyForTrips ? 'да' : 'нет'}

Создай хук:`;

    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        temperature: 0.3,
        max_tokens: 80
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const aiResponse = response.data.choices[0].message.content.trim();

    // Если AI вернул SKIP или пустой ответ - возвращаем null
    if (!aiResponse || aiResponse === 'SKIP' || aiResponse.length > 60) {
      console.log('⚠️ Хук не создан (SKIP или слишком длинный)');
      return null;
    }

    console.log('✅ Хук создан:', aiResponse);
    return aiResponse;

  } catch (error) {
    console.error('❌ Ошибка генерации хука через Deepseek:', error.response?.data || error.message);
    return null;
  }
}

// Генерация хука для заявки заказчика через Deepseek AI
async function generateOrderHook(orderData) {
  try {
    // Если API ключ не настроен, возвращаем null
    if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'your_deepseek_api_key_here') {
      console.log('⚠️ DEEPSEEK_API_KEY не настроен, пропускаем генерацию хука');
      return null;
    }

    // Формируем входные данные для AI
    const inputData = {
      requestType: orderData.requestType || '',
      workType: orderData.workType || '',
      objectType: orderData.objectType || '',
      cityLocation: orderData.cityLocation || '',
      executorRequirements: orderData.executorRequirements || '',
      validityPeriod: orderData.validityPeriod || ''
    };

    const systemPrompt = `Ты создаешь короткие цепляющие хуки (заголовки) для заявок на строительные работы.

ЗАДАЧА: Создай хук по формуле [Тип работ] + [особенность заказа] — [что предлагается]

ПРАВИЛА:
1. Максимум 60 символов
2. БЕЗ штампов типа "срочно требуется", "высокая оплата"
3. Конкретика: тип объекта, особые условия, сроки
4. Если заявка стандартная без особенностей — верни "SKIP"
5. Используй конкретные факты из данных

ПРИМЕРЫ ХОРОШИХ ХУКОВ:
✅ "Отделка ЖК 200 квартир — долгосрочный контракт"
✅ "Кровля промобъекта — оплата каждую неделю"
✅ "Фасад 12 этажей — работа с вышкой и бригадой"
✅ "Электрика коттеджа — готовые проекты и материалы"

ПРИМЕРЫ ПЛОХИХ ХУКОВ:
❌ "Требуется электрик на объект"
❌ "Ищем бригаду для работ"
❌ "Срочно нужен мастер"

Верни ТОЛЬКО текст хука или слово "SKIP"`;

    const userPrompt = `Данные заявки:
Тип запроса: ${inputData.requestType}
Город: ${inputData.cityLocation}
Тип объекта: ${inputData.objectType}
Вид работ: ${inputData.workType}
Требования: ${inputData.executorRequirements || 'не указаны'}
Срок актуальности: ${inputData.validityPeriod}

Создай хук:`;

    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        temperature: 0.3,
        max_tokens: 80
      },
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const aiResponse = response.data.choices[0].message.content.trim();

    // Если AI вернул SKIP или пустой ответ - возвращаем null
    if (!aiResponse || aiResponse === 'SKIP' || aiResponse.length > 60) {
      console.log('⚠️ Хук не создан (SKIP или слишком длинный)');
      return null;
    }

    console.log('✅ Хук создан:', aiResponse);
    return aiResponse;

  } catch (error) {
    console.error('❌ Ошибка генерации хука через Deepseek:', error.response?.data || error.message);
    return null;
  }
}

// Форматирование текста для Telegram (Markdown)
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Форматирование текущей анкеты для отображения
function formatCurrentFormData(userData, currentStep) {
  let formText = '📋 <b>Твоя анкета:</b>\n\n';

  if (userData.workFormat) {
    formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;
  }
  if (userData.specialization) {
    formText += `2️⃣ Специализация: ${userData.specialization}\n`;
  }
  if (userData.city) {
    formText += `3️⃣ Город: ${userData.city}\n`;
  }
  if (userData.name) {
    formText += `4️⃣ Имя: ${userData.name}\n`;
  }
  if (userData.experience) {
    formText += `5️⃣ Опыт: ${userData.experience}\n`;
  }
  if (userData.objectsWorked) {
    formText += `6️⃣ Объекты: ${userData.objectsWorked}\n`;
  }
  if (userData.professionalAdvantages) {
    formText += `7️⃣ Преимущества: ${userData.professionalAdvantages}\n`;
  }
  if (userData.cooperationFormat) {
    formText += `8️⃣ Формат сотрудничества: ${userData.cooperationFormat}\n`;
  }
  if (userData.paymentConditions) {
    formText += `9️⃣ Условия оплаты: ${userData.paymentConditions}\n`;
  }
  if (userData.contact) {
    formText += `🔟 Контакт: ${userData.contact}\n`;
  }
  if (currentStep >= 11) {
    const portfolioCount = userData.portfolio ? userData.portfolio.length : 0;
    if (portfolioCount > 0) {
      formText += `1️⃣1️⃣ Портфолио: ${portfolioCount} фото\n`;
    }
  }

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  return formText;
}

// Проверка роли пользователя (этап 2) - поиск в таблице user_roles
async function checkUserRole(userId) {
  try {
    // Проверка наличия URL и ключа
    if (!SUPABASE_URL || SUPABASE_URL === 'your_supabase_url_here') {
      console.error('❌ SUPABASE_URL не настроен в .env файле');
      return null;
    }

    if (!SUPABASE_KEY || SUPABASE_KEY === 'your_supabase_key_here') {
      console.error('❌ SUPABASE_KEY не настроен в .env файле');
      return null;
    }

    // Проверяем в таблице user_roles
    const { data: roleData, error: roleError } = await supabase
      .from('user_roles')
      .select('role')
      .eq('telegram_id', userId)
      .single();

    if (roleData && roleData.role) {
      console.log(`✅ Роль найдена в user_roles: ${roleData.role}`);
      return roleData.role;
    }

    // Роль не найдена
    console.log(`ℹ️ Роль для пользователя ${userId} не найдена`);
    return null;

  } catch (error) {
    // Ошибка может быть, если запись не найдена (это нормально)
    if (error.code !== 'PGRST116') { // PGRST116 = not found
      console.error('❌ Ошибка проверки роли:', error.message);
    }
    return null;
  }
}

// Сохранение роли пользователя (этап 2) - новая функция
async function saveUserRole(userId, role) {
  try {
    // Проверка наличия URL и ключа
    if (!SUPABASE_URL || SUPABASE_URL === 'your_supabase_url_here') {
      console.error('❌ SUPABASE_URL не настроен в .env файле');
      return { success: false, error: 'Supabase URL не настроен' };
    }

    if (!SUPABASE_KEY || SUPABASE_KEY === 'your_supabase_key_here') {
      console.error('❌ SUPABASE_KEY не настроен в .env файле');
      return { success: false, error: 'Supabase KEY не настроен' };
    }

    // Сначала проверяем, есть ли уже роль для этого пользователя
    const { data: existing, error: checkError } = await supabase
      .from('user_roles')
      .select('*')
      .eq('telegram_id', userId)
      .single();

    if (existing) {
      // Если роль уже есть - обновляем
      const { data: result, error } = await supabase
        .from('user_roles')
        .update({
          role: role,
          updated_at: new Date().toISOString()
        })
        .eq('telegram_id', userId)
        .select();

      if (error) {
        console.error('❌ Ошибка обновления роли:', error.message);
        throw error;
      }

      console.log('✅ Роль обновлена в БД:', result);
      return { success: true, data: result, isNew: false };
    } else {
      // Если роли нет - создаем новую запись
      const { data: result, error } = await supabase
        .from('user_roles')
        .insert([
          {
            telegram_id: userId,
            role: role,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        ])
        .select();

      if (error) {
        console.error('❌ Ошибка Supabase при сохранении роли:', error.message, error.details, error.hint);
        throw error;
      }

      console.log('✅ Роль сохранена в БД:', result);
      return { success: true, data: result, isNew: true };
    }
  } catch (error) {
    console.error('❌ Ошибка сохранения роли в БД:', {
      message: error.message || 'Неизвестная ошибка',
      details: error.details || '',
      hint: error.hint || '',
      code: error.code || ''
    });
    return { success: false, error };
  }
}

// Сохранение источника трафика пользователя (этап 1)
async function saveUserSource(userId, source = 'другое') {
  try {
    // Проверка наличия URL и ключа
    if (!SUPABASE_URL || SUPABASE_URL === 'your_supabase_url_here') {
      console.error('❌ SUPABASE_URL не настроен в .env файле');
      return { success: false, error: 'Supabase URL не настроен' };
    }

    if (!SUPABASE_KEY || SUPABASE_KEY === 'your_supabase_key_here') {
      console.error('❌ SUPABASE_KEY не настроен в .env файле');
      return { success: false, error: 'Supabase KEY не настроен' };
    }

    // Проверяем, есть ли уже запись для этого пользователя
    const { data: existing, error: checkError } = await supabase
      .from('user_sources')
      .select('*')
      .eq('telegram_id', userId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 = not found
      console.error('❌ Ошибка проверки источника:', checkError);
      return { success: false, error: checkError };
    }

    // Если пользователь уже есть в базе - не добавляем повторно
    if (existing) {
      console.log(`✅ Источник для пользователя ${userId} уже сохранен: ${existing.source}`);
      return { success: true, data: existing, isNew: false };
    }

    // Сохраняем новую запись
    const { data: result, error } = await supabase
      .from('user_sources')
      .insert([
        {
          telegram_id: userId,
          source: source,
          created_at: new Date().toISOString()
        }
      ])
      .select();

    if (error) {
      console.error('❌ Ошибка Supabase при сохранении источника:', error.message, error.details, error.hint);
      throw error;
    }

    console.log('✅ Источник трафика сохранен в БД:', result);
    return { success: true, data: result, isNew: true };
  } catch (error) {
    console.error('❌ Ошибка сохранения источника в БД:', {
      message: error.message || 'Неизвестная ошибка',
      details: error.details || '',
      hint: error.hint || '',
      code: error.code || ''
    });
    return { success: false, error };
  }
}

// Сохранение анкеты в Supabase
async function saveContractorToDatabase(data) {
  try {
    // Проверка наличия URL и ключа
    if (!SUPABASE_URL || SUPABASE_URL === 'your_supabase_url_here') {
      console.error('❌ SUPABASE_URL не настроен в .env файле');
      return { success: false, error: 'Supabase URL не настроен' };
    }

    if (!SUPABASE_KEY || SUPABASE_KEY === 'your_supabase_key_here') {
      console.error('❌ SUPABASE_KEY не настроен в .env файле');
      return { success: false, error: 'Supabase KEY не настроен' };
    }

    const { data: result, error } = await supabase
      .from('contractors')
      .insert([
        {
          telegram_id: data.userId,
          username: data.username,
          name: data.name || 'Не указано', // этап 3: теперь берем из формы
          description: data.specialization || 'Не указано',
          price: 0,
          work_format: data.workFormat,
          city: data.city,
          ready_for_trips: data.readyForTrips || false, // этап 3: готовность к командировкам
          specialization: data.specialization,
          experience: data.experience,
          objects_worked: data.objectsWorked,
          professional_advantages: data.professionalAdvantages || null, // этап 3: преимущества
          cooperation_format: data.cooperationFormat, // этап 3: переименовано из documents_form
          payment_conditions: data.paymentConditions,
          contact: data.contact,
          photo_url: data.photoUrl || null,
          portfolio_photos: data.portfolio || [], // Сохраняем весь массив фотографий портфолио
          telegram_tag: data.telegramTag,
          category: data.category || null, // этап 5: AI-определенная категория
          work_area: data.workArea || null, // Область работ на основе категории
          role: data.role || null, // этап 2: сохраняем роль
          hook: data.hook || null, // Сохраняем хук
          status: 'approved', // одобрено
          created_at: new Date().toISOString()
        }
      ])
      .select();

    if (error) {
      console.error('❌ Ошибка Supabase:', error.message, error.details, error.hint);
      throw error;
    }

    console.log('✅ Данные успешно сохранены в БД:', result);
    return { success: true, data: result };
  } catch (error) {
    console.error('❌ Ошибка сохранения в БД:', {
      message: error.message || 'Неизвестная ошибка',
      details: error.details || '',
      hint: error.hint || '',
      code: error.code || ''
    });
    return { success: false, error };
  }
}

// Сохранение жалобы в Supabase
async function saveComplaintToDatabase(data) {
  try {
    // Проверка наличия URL и ключа
    if (!SUPABASE_URL || SUPABASE_URL === 'your_supabase_url_here') {
      console.error('❌ SUPABASE_URL не настроен в .env файле');
      return { success: false, error: 'Supabase URL не настроен' };
    }

    if (!SUPABASE_KEY || SUPABASE_KEY === 'your_supabase_key_here') {
      console.error('❌ SUPABASE_KEY не настроен в .env файле');
      return { success: false, error: 'Supabase KEY не настроен' };
    }

    const { data: result, error } = await supabase
      .from('complaints')
      .insert([
        {
          telegram_id: data.userId,
          contractor_id: data.contractorId || null,
          message: data.message,
          status: 'new',
          created_at: new Date().toISOString(),
          telegram_tag: data.telegramTag || null
        }
      ])
      .select();

    if (error) {
      console.error('❌ Ошибка Supabase при сохранении жалобы:', error.message, error.details, error.hint);
      throw error;
    }

    console.log('✅ Жалоба успешно сохранена в БД:', result);
    return { success: true, data: result };
  } catch (error) {
    console.error('❌ Ошибка сохранения жалобы в БД:', {
      message: error.message || 'Неизвестная ошибка',
      details: error.details || '',
      hint: error.hint || '',
      code: error.code || ''
    });
    return { success: false, error };
  }
}

// Сохранение заказа (Order) в Supabase
async function saveOrderToDatabase(data) {
  try {
    // Проверка наличия URL и ключа
    if (!SUPABASE_URL || SUPABASE_URL === 'your_supabase_url_here') {
      console.error('❌ SUPABASE_URL не настроен в .env файле');
      return { success: false, error: 'Supabase URL не настроен' };
    }

    if (!SUPABASE_KEY || SUPABASE_KEY === 'your_supabase_key_here') {
      console.error('❌ SUPABASE_KEY не настроен в .env файле');
      return { success: false, error: 'Supabase KEY не настроен' };
    }

    // Вычисляем дату истечения срока актуальности
    const expiresAt = calculateExpirationDate(data.validityPeriod);

    const { data: result, error } = await supabase
      .from('orders')
      .insert([
        {
          telegram_id: data.userId,
          username: data.username,
          request_type: data.requestType,
          city_location: data.cityLocation,
          object_type: data.objectType,
          work_type: data.workType,
          executor_requirements: data.executorRequirements,
          validity_period: data.validityPeriod,
          expires_at: expiresAt,
          company_name: data.companyName,
          contact: data.contact,
          telegram_tag: data.telegramTag,
          category: data.category || null, // этап 5: AI-определенная категория
          work_area: data.workArea || null, // Область работ на основе категории
          role: data.role || null, // этап 2: сохраняем роль
          hook: data.hook || null, // Сохраняем хук
          status: 'approved',
          created_at: new Date().toISOString()
        }
      ])
      .select();

    if (error) {
      console.error('❌ Ошибка Supabase при сохранении заказа:', error.message, error.details, error.hint);
      throw error;
    }

    console.log('✅ Заказ успешно сохранён в БД:', result);
    return { success: true, data: result };
  } catch (error) {
    console.error('❌ Ошибка сохранения заказа в БД:', {
      message: error.message || 'Неизвестная ошибка',
      details: error.details || '',
      hint: error.hint || '',
      code: error.code || ''
    });
    return { success: false, error };
  }
}

// Сохранение поставщика (Supplier) в Supabase
// ==================== КЛАВИАТУРЫ ====================

const communityKeyboard = {
  reply_markup: {
    keyboard: [],
    resize_keyboard: true
  }
};

const mainMenuKeyboard = communityKeyboard; // Для обратной совместимости

const confirmStartFormKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Да, начать', callback_data: 'start_form' }],
      [{ text: '❌ Отмена', callback_data: 'cancel_form' }]
    ]
  }
};

const checkSubscriptionKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Я подписался', callback_data: 'check_subscription' }],
      [{ text: '📢 Перейти в канал', url: `https://t.me/${CHANNEL_ID.replace('@', '')}` }]
    ]
  }
};

const cancelKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '❌ Отменить заполнение' }]
    ],
    resize_keyboard: true
  }
};

const cancelWithBackKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '◀️ Назад' }],
      [{ text: '❌ Отменить заполнение' }]
    ],
    resize_keyboard: true
  }
};

// Клавиатура стартового экрана (этап 1)
const welcomeScreenKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '👥 В сообщество «Голос Стройки»', url: `https://t.me/${CHANNEL_ID.replace('@', '')}` }],
      [{ text: '🗂 В Базу', callback_data: 'go_to_database' }]
    ]
  }
};

// Клавиатура выбора роли (этап 2)
const roleSelectionKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '👷 Рабочий', callback_data: 'role_worker' }],
      [{ text: '👔 Бригадир', callback_data: 'role_foreman' }],
      [{ text: '🏢 Подрядчик / Компания', callback_data: 'role_contractor' }],
      [{ text: '💼 Заказчик', callback_data: 'role_customer' }],
      [{ text: '🎓 Эксперт', callback_data: 'role_expert' }],
      [{ text: '👁 Наблюдатель', callback_data: 'role_observer' }]
    ]
  }
};

// ==================== КОМАНДЫ ====================

// Показать стартовый экран приветствия (этап 1)
async function showWelcomeScreen(chatId) {
  const welcomeText = `<b>Добро пожаловать в «Голос Стройки»</b> 👋
Это пространство для тех, кто реально работает в стройке.

👥 <b>в Сообществе</b> ты можешь общаться, знакомиться с профессионалами, строителями и заказчиками. Найти поддержку или помочь другим.

🗂️ <b>в Базе</b> — ты можешь найти работу или нужных специалистов на свой объект

<i>Выбери, с чего хочешь начать</i> 👇`;

  await bot.sendMessage(chatId, welcomeText, {
    parse_mode: 'HTML',
    ...welcomeScreenKeyboard
  });
}

// Показать экран выбора роли (этап 2)
async function showRoleSelection(chatId) {
  const roleText = `Привет 👋
Ты в <b>Базе сообщества «Голос Стройки»</b>.

Здесь ты можешь:
— найти работу
— найти любых специалистов из Базы

<i>Все анкеты и заявки на поиск людей публикуются
в сообществе «Голос Стройки».</i>

Выбери свою роль в сообществе, это поможет более точно отвечать на твои запросы 👇

⚠️ <i>Роль не ограничивает доступ и общение.</i>`;

  await bot.sendMessage(chatId, roleText, {
    parse_mode: 'HTML',
    ...roleSelectionKeyboard
  });
}

// Команда /start
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || 'без username';

  // Игнорируем команды из каналов и групп - работаем только в личных чатах
  if (msg.chat.type !== 'private') {
    return;
  }

  console.log(`Пользователь ${username} (${userId}) запустил бота`);

  // Парсим deep link параметр
  const param = match[1].trim(); // " contractor_123" или " order_456" или ""

  if (param.startsWith('contractor_')) {
    // Сохраняем ID анкеты для показа после онбординга
    const contractorId = param.replace('contractor_', '');
    pendingDeepLinks[userId] = { type: 'contractor', id: contractorId };
    console.log(`🔗 Deep link: сохранён ID анкеты ${contractorId} для пользователя ${userId}`);
  } else if (param.startsWith('order_')) {
    // Сохраняем ID заявки для показа после онбординга
    const orderId = param.replace('order_', '');
    pendingDeepLinks[userId] = { type: 'order', id: orderId };
    console.log(`🔗 Deep link: сохранён ID заявки ${orderId} для пользователя ${userId}`);
  }

  // Сохраняем источник трафика при первом запуске (этап 1)
  await saveUserSource(userId, param ? 'deep_link' : 'другое');

  // Если есть deep link параметр - пропускаем приветственный экран
  if (pendingDeepLinks[userId]) {
    // Проверяем подписку на канал
    const isSubscribed = await checkSubscription(userId);

    if (!isSubscribed) {
      // Если не подписан - показываем сообщение с просьбой подписаться
      const subscriptionText = `Чтобы пользоваться <b>Базой сообщества</b>,
нужно быть подписанным на сообщество «Голос Стройки».

<i>Все анкеты и заявки публикуются именно там.</i>

Подпишись на сообщество и возвращайся в бот 👇`;

      await bot.sendMessage(chatId, subscriptionText, {
        parse_mode: 'HTML',
        ...checkSubscriptionKeyboard,
        disable_web_page_preview: true
      });
      return;
    }

    // Проверяем, есть ли уже роль у пользователя
    const userRole = await checkUserRole(userId);

    if (!userRole) {
      // Роль не найдена - показываем экран выбора роли (без приветственного экрана)
      await showRoleSelection(chatId);
      return;
    }

    // Роль есть и подписан - сразу показываем анкету
    await showDeepLinkedProfile(chatId, userId);
    return;
  }

  // Новый пользователь без deep link - показываем стартовый экран
  await showWelcomeScreen(chatId);
});

// Показать анкету/заявку по deep link
async function showDeepLinkedProfile(chatId, userId) {
  const deepLinkData = pendingDeepLinks[userId];

  if (!deepLinkData) {
    // Если данных нет - показываем главное меню
    await showMainMenu(chatId);
    return;
  }

  try {
    if (deepLinkData.type === 'contractor') {
      // Получаем анкету специалиста из БД
      const { data: contractor, error } = await supabase
        .from('contractors')
        .select('*')
        .eq('id', deepLinkData.id)
        .single();

      if (error || !contractor) {
        console.error('❌ Ошибка получения анкеты:', error?.message);
        await bot.sendMessage(chatId, '❌ Анкета не найдена или была удалена.');
        delete pendingDeepLinks[userId];
        await showMainMenu(chatId);
        return;
      }

      // Получаем роль специалиста
      const userRole = contractor.telegram_id ? await checkUserRole(contractor.telegram_id) : null;

      // Форматируем карточку
      const cardText = formatContractorCard(contractor, userRole);

      // Кнопки навигации
      const buttons = [
        [{ text: '🔎 Найти еще специалистов', callback_data: 'search_people' }],
        [{ text: '💼 Найти работу', callback_data: 'search_work' }],
        [{ text: '🏠 В меню', callback_data: 'main_menu' }]
      ];

      // Отправляем анкету
      await bot.sendMessage(chatId, cardText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: buttons
        }
      });

      // Очищаем сохранённый deep link
      delete pendingDeepLinks[userId];

    } else if (deepLinkData.type === 'order') {
      // Получаем заявку из БД
      const { data: order, error } = await supabase
        .from('orders')
        .select('*')
        .eq('id', deepLinkData.id)
        .single();

      if (error || !order) {
        console.error('❌ Ошибка получения заявки:', error?.message);
        await bot.sendMessage(chatId, '❌ Заявка не найдена или была удалена.');
        delete pendingDeepLinks[userId];
        await showMainMenu(chatId);
        return;
      }

      // Получаем роль компании
      const companyRole = order.telegram_id ? await checkUserRole(order.telegram_id) : null;

      // Форматируем карточку
      const cardText = formatOrderCard(order, companyRole);

      // Кнопки навигации
      const buttons = [
        [{ text: '🔎 Найти еще специалистов', callback_data: 'search_people' }],
        [{ text: '💼 Найти работу', callback_data: 'search_work' }],
        [{ text: '🏠 В меню', callback_data: 'main_menu' }]
      ];

      // Отправляем заявку
      await bot.sendMessage(chatId, cardText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: buttons
        }
      });

      // Очищаем сохранённый deep link
      delete pendingDeepLinks[userId];
    }
  } catch (error) {
    console.error('❌ Ошибка при показе deep link профиля:', error.message);
    await bot.sendMessage(chatId, '❌ Произошла ошибка при загрузке данных.');
    delete pendingDeepLinks[userId];
    await showMainMenu(chatId);
  }
}

// Показать главное меню
async function showMainMenu(chatId) {
  const menuText = `Здесь ты можешь:

🔨 <b>Найти работу</b>
Заполни анкету исполнителя — заказчики найдут тебя сами.

👷 <b>Найти людей</b>
Найди специалистов через быстрый поиск
или создай заявку — исполнители сами свяжутся с тобой.

❓Если у вас возникли вопросы или предложения по работе «Базы» обращайтесь сюда @arrtproduction`;

  // Отправляем сообщение с инлайн-кнопками и сохраняем ID
  const menuMessage = await bot.sendMessage(chatId, menuText, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔎 Ищу работу', callback_data: 'search_work' }],
        [{ text: '👥 Ищу людей', callback_data: 'search_people' }],
        [{ text: '📌 Моя анкета / заявка', callback_data: 'my_profile' }]
        // [{ text: '🧭 Инструкции к боту', callback_data: 'faq_help' }],
        // [{ text: '⭕️ Жалобы и предложения', callback_data: 'send_complaint' }]
      ]
    }
  });

  // Сохраняем ID сообщения с меню для последующего удаления
  liveMessages[chatId] = { menuMessageId: menuMessage.message_id };
}

// ==================== ОБРАБОТКА CALLBACK ====================

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // Обработка кнопки "В Базу" со стартового экрана (этап 1)
  if (data === 'go_to_database') {
    await bot.answerCallbackQuery(query.id);

    // Удаляем стартовое сообщение
    await safeDeleteMessage(chatId, query.message.message_id);

    // Проверяем подписку на канал
    const isSubscribed = await checkSubscription(userId);

    if (!isSubscribed) {
      // Если не подписан - показываем сообщение с просьбой подписаться
      const subscriptionText = `Чтобы пользоваться <b>Базой сообщества</b>,
нужно быть подписанным на сообщество «Голос Стройки».

<i>Все анкеты и заявки публикуются именно там.</i>

Подпишись на сообщество и возвращайся в бот 👇`;

      await bot.sendMessage(chatId, subscriptionText, {
        parse_mode: 'HTML',
        ...checkSubscriptionKeyboard,
        disable_web_page_preview: true
      });
      return;
    }

    // Если подписан - проверяем роль (этап 2)
    const userRole = await checkUserRole(userId);

    if (!userRole) {
      // Роль не найдена - показываем экран выбора роли
      await showRoleSelection(chatId);
      return;
    }

    // Проверяем, есть ли сохранённый deep link
    if (pendingDeepLinks[userId]) {
      await showDeepLinkedProfile(chatId, userId);
      return;
    }

    // Роль найдена - переходим к главному меню
    await showMainMenu(chatId);
    return;
  }

  // Проверка подписки
  if (data === 'check_subscription') {
    const isSubscribed = await checkSubscription(userId);

    if (isSubscribed) {
      await safeDeleteMessage(chatId, query.message.message_id);
      await bot.answerCallbackQuery(query.id, { text: '✅ Отлично! Подписка подтверждена' });

      // Проверяем роль после подтверждения подписки (этап 2)
      const userRole = await checkUserRole(userId);

      if (!userRole) {
        // Роль не найдена - показываем экран выбора роли
        await showRoleSelection(chatId);
        return;
      }

      // Проверяем, есть ли сохранённый deep link
      if (pendingDeepLinks[userId]) {
        await showDeepLinkedProfile(chatId, userId);
        return;
      }

      // Роль найдена - переходим к главному меню
      await showMainMenu(chatId);
    } else {
      await bot.answerCallbackQuery(query.id, {
        text: '❌ Подписка не найдена. Пожалуйста, подпишись на канал.',
        show_alert: true
      });
    }
    return;
  }

  // Обработка выбора роли (этап 2)
  if (data.startsWith('role_')) {
    await bot.answerCallbackQuery(query.id);

    // Определяем выбранную роль
    let selectedRole = '';
    if (data === 'role_worker') selectedRole = 'рабочий';
    else if (data === 'role_foreman') selectedRole = 'бригадир';
    else if (data === 'role_contractor') selectedRole = 'подрядчик/компания';
    else if (data === 'role_customer') selectedRole = 'заказчик';
    else if (data === 'role_expert') selectedRole = 'эксперт';
    else if (data === 'role_observer') selectedRole = 'наблюдатель';

    console.log(`✅ Пользователь ${userId} выбрал роль: ${selectedRole}`);

    // НОВОЕ: Сохраняем роль в БД сразу же (этап 2)
    const roleResult = await saveUserRole(userId, selectedRole);

    // Удаляем сообщение с выбором роли
    await safeDeleteMessage(chatId, query.message.message_id);

    if (roleResult.success) {
      // Показываем подтверждение выбора роли
      const confirmMsg = await bot.sendMessage(chatId, `✅ Роль выбрана: <b>${selectedRole}</b>\n\nЭту роль будет учитываться при заполнении анкет.`, {
        parse_mode: 'HTML'
      });

      // Удаляем подтверждение через 5 секунд
      deleteMessageAfterDelay(chatId, confirmMsg.message_id, 5000);
    } else {
      // Если сохранение роли не удалось
      const errorMsg = await bot.sendMessage(chatId, '⚠️ Не удалось сохранить роль. Попробуй еще раз.', {
        parse_mode: 'HTML'
      });
      deleteMessageAfterDelay(chatId, errorMsg.message_id, 5000);
    }

    // Проверяем, есть ли сохранённый deep link
    if (pendingDeepLinks[userId]) {
      await showDeepLinkedProfile(chatId, userId);
      return;
    }

    // Переходим к главному меню
    await showMainMenu(chatId);
    return;
  }

  // Начало заполнения анкеты
  if (data === 'start_form') {
    await safeDeleteMessage(chatId, query.message.message_id);
    await startFormProcess(chatId, userId, query.from.username);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // Начало заполнения формы заказа
  if (data === 'start_order_form') {
    await safeDeleteMessage(chatId, query.message.message_id);
    await startOrderFormProcess(chatId, userId, query.from.username);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // Отмена анкеты
  if (data === 'cancel_form') {
    if (userStates[userId]) {
      delete userStates[userId];
    }
    await safeDeleteMessage(chatId, query.message.message_id);
    const cancelMsg = await bot.sendMessage(chatId, '❌ Заполнение анкеты отменено.', mainMenuKeyboard);
    deleteMessageAfterDelay(chatId, cancelMsg.message_id);
    await bot.answerCallbackQuery(query.id);
    await showMainMenu(chatId);
    return;
  }

  // Возврат в главное меню
  if (data === 'main_menu') {
    await safeDeleteMessage(chatId, query.message.message_id);
    await bot.answerCallbackQuery(query.id);

    // ИСПРАВЛЕНИЕ: Очищаем все состояния при возврате в меню
    if (userStates[userId]) {
      delete userStates[userId];
    }
    if (searchStates[userId]) {
      delete searchStates[userId];
    }

    await showMainMenu(chatId);
    return;
  }

  // Пропуск фото на шаге 10
  // Подтверждение анкеты на шаге 11 (Contractor) - больше нет отдельного шага финального согласования
  if (data === 'confirm_form') {
    await bot.answerCallbackQuery(query.id);

    if (userStates[userId] && userStates[userId].formType === 'contractor' && userStates[userId].step === 11) {
      // Редактируем сообщение: убираем кнопки и служебную часть, оставляя только данные анкеты
      try {
        const userData = userStates[userId].data;
        const formData = formatCurrentFormData(userData, 11);

        await bot.editMessageText(formData.trim(), {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }
        });
      } catch (error) {
        // Игнорируем ошибку если сообщение не удалось отредактировать
      }

      // Завершаем анкету и отправляем в БД
      await finishForm(chatId, userId, query.from.username);
    }
    return;
  }

  // Подтверждение заявки на шаге 10 (Order)
  if (data === 'confirm_order_form') {
    await bot.answerCallbackQuery(query.id);

    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 10) {
      // Редактируем сообщение: убираем кнопки и служебную часть, оставляя только данные заявки
      try {
        const userData = userStates[userId].data;
        let formText = '📋 <b>Твоя заявка:</b>\n\n';

        if (userData.requestType) formText += `1️⃣ Кого ищешь: ${userData.requestType}\n`;
        if (userData.cityLocation) formText += `2️⃣ Город: ${userData.cityLocation}\n`;
        if (userData.objectType) formText += `3️⃣ Тип объекта: ${userData.objectType}\n`;
        if (userData.workType) formText += `4️⃣ Задача: ${userData.workType}\n`;
        if (userData.executorRequirements) formText += `5️⃣ Требования: ${userData.executorRequirements}\n`;
        if (userData.validityPeriod) formText += `6️⃣ Срок актуальности: ${userData.validityPeriod}\n`;
        if (userData.companyName) formText += `7️⃣ Компания: ${userData.companyName}\n`;
        if (userData.contact) formText += `8️⃣ Контакт: ${userData.contact}\n`;

        await bot.editMessageText(formText.trim(), {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }
        });
      } catch (error) {
        // Игнорируем ошибку если сообщение не удалось отредактировать
      }

      // Завершаем заявку и отправляем в БД
      await finishOrderForm(chatId, userId);
    }
    return;
  }

  // Кнопка "Назад" в анкете (инлайн)
  if (data === 'form_back') {
    await bot.answerCallbackQuery(query.id);

    if (userStates[userId] && userStates[userId].step > 1) {
      userStates[userId].step -= 1;

      // Вызываем соответствующий шаг
      switch (userStates[userId].step) {
        case 1:
          await askStep1(chatId, userId);
          break;
        case 2:
          await askStep2(chatId, userId);
          break;
        case 3:
          await askStep3(chatId, userId);
          break;
        case 4:
          await askStep4(chatId, userId);
          break;
        case 5:
          await askStep5(chatId, userId);
          break;
        case 6:
          await askStep6(chatId, userId);
          break;
        case 7:
          await askStep7(chatId, userId);
          break;
        case 8:
          await askStep8(chatId, userId);
          break;
        case 9:
          await askStep9(chatId, userId);
          break;
        case 10:
          await askStep10(chatId, userId);
          break;
      }
    }
    return;
  }

  // Обработка кнопок выбора формата работы (шаг 1)
  if (data.startsWith('wf_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].step === 1) {
      let workFormat = '';
      if (data === 'wf_specialist') workFormat = 'Специалист';
      else if (data === 'wf_brigade') workFormat = 'Бригада';
      else if (data === 'wf_company') workFormat = 'Компания';

      userStates[userId].data.workFormat = workFormat;
      userStates[userId].step = 2;
      await askStep2(chatId, userId);
    }
    return;
  }

  // Обработка кнопок выбора города (шаг 3)
  if (data.startsWith('city_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].step === 3) {
      let city = '';
      if (data === 'city_moscow') city = 'Москва';
      else if (data === 'city_spb') city = 'Санкт-Петербург';
      else if (data === 'city_any') city = 'Готов работать в любом городе';

      userStates[userId].data.city = city;
      userStates[userId].step = 4;
      await askStep4(chatId, userId);
    }
    return;
  }

  // Обработка переключателя командировок (шаг 3)
  if (data === 'toggle_trips') {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].step === 3) {
      // Переключаем состояние
      userStates[userId].data.readyForTrips = !userStates[userId].data.readyForTrips;
      // Перерисовываем шаг 3 с новым состоянием
      await askStep3(chatId, userId);
    }
    return;
  }

  // Обработка кнопок выбора опыта (шаг 5)
  if (data.startsWith('exp_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].step === 5) {
      let experience = '';
      if (data === 'exp_less1') experience = 'Менее 1 года';
      else if (data === 'exp_1_3') experience = '1-3 года';
      else if (data === 'exp_3_5') experience = '3-5 лет';
      else if (data === 'exp_5_10') experience = '5-10 лет';
      else if (data === 'exp_more10') experience = 'Более 10 лет';

      userStates[userId].data.experience = experience;
      userStates[userId].step = 6;
      await askStep6(chatId, userId);
    }
    return;
  }

  // Обработка кнопки пропустить профессиональные преимущества (шаг 7)
  if (data === 'skip_advantages') {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].step === 7) {
      userStates[userId].data.professionalAdvantages = null;
      userStates[userId].step = 8;
      await askStep8(chatId, userId);
    }
    return;
  }

  // Обработка кнопок формата сотрудничества (шаг 8, переименовано из doc_)
  if (data.startsWith('coop_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].step === 8) {
      let cooperationFormat = '';
      if (data === 'coop_ip') cooperationFormat = 'ИП';
      else if (data === 'coop_samozanyaty') cooperationFormat = 'Самозанятый';
      else if (data === 'coop_ooo') cooperationFormat = 'ООО';
      else if (data === 'coop_contract') cooperationFormat = 'По договору';
      else if (data === 'coop_none') cooperationFormat = 'Без оформления';
      else if (data === 'coop_any') cooperationFormat = 'Любой формат';

      userStates[userId].data.cooperationFormat = cooperationFormat;
      userStates[userId].step = 9;
      await askStep9(chatId, userId);
    }
    return;
  }

  // Обработка кнопок условий оплаты (Contractor шаг 9)
  if (data.startsWith('payment_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'contractor' && userStates[userId].step === 9) {
      let paymentConditions = '';
      if (data === 'payment_cash') paymentConditions = 'Нал';
      else if (data === 'payment_cashless') paymentConditions = 'Безнал';
      else if (data === 'payment_negotiable') paymentConditions = 'Обсуждается';

      userStates[userId].data.paymentConditions = paymentConditions;
      userStates[userId].step = 10;
      await askStep10(chatId, userId);
    }
    return;
  }


  // ========== CALLBACK HANDLERS ДЛЯ ВЕТКИ ORDER ==========

  // Обработка кнопок типа запроса (Order Step 1)
  if (data.startsWith('ord_req_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 1) {
      let requestType = '';
      if (data === 'ord_req_brigade') requestType = 'Бригаду / подрядчика';
      else if (data === 'ord_req_workers') requestType = 'Рабочих по сменам';
      else if (data === 'ord_req_engineers') requestType = 'Инженерный состав';

      userStates[userId].data.requestType = requestType;
      userStates[userId].step = 2;

      await askOrderStep2(chatId, userId);
    }
    return;
  }

  // Обработка кнопок формата работы (Order Step 1)
  if (data.startsWith('ord_format_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 1) {
      let workFormat = '';
      if (data === 'ord_format_specialist') workFormat = 'Специалиста';
      else if (data === 'ord_format_team') workFormat = 'Бригаду';
      else if (data === 'ord_format_company') workFormat = 'Компанию/подрядчика';

      userStates[userId].data.workFormat = workFormat;
      userStates[userId].step = 2;

      await askOrderStep2(chatId, userId);
    }
    return;
  }

  // Обработка кнопок города (Order Step 3)
  if (data.startsWith('ord_city_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 3) {
      let city = '';
      if (data === 'ord_city_moscow') city = 'Москва';
      else if (data === 'ord_city_spb') city = 'Санкт-Петербург';

      userStates[userId].data.cityLocation = city;
      userStates[userId].step = 4;

      await askOrderStep4(chatId, userId);
    }
    return;
  }

  // Обработка кнопок типа объекта (Order Step 4)
  if (data.startsWith('ord_obj_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 4) {
      let objectType = '';
      if (data === 'ord_obj_apartment') objectType = 'Квартира';
      else if (data === 'ord_obj_house') objectType = 'Дом';
      else if (data === 'ord_obj_residential') objectType = 'ЖК';
      else if (data === 'ord_obj_commercial') objectType = 'Коммерция';
      else if (data === 'ord_obj_industrial') objectType = 'Промышленный';
      else if (data === 'ord_obj_roads') objectType = 'Дороги';

      userStates[userId].data.objectType = objectType;
      userStates[userId].step = 5;

      await askOrderStep5(chatId, userId);
    }
    return;
  }

  // Обработка кнопок требований к исполнителю (Order шаг 7 - опыт)
  if (data.startsWith('ord_exp_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 7) {
      let experience = '';
      if (data === 'ord_exp_less1') experience = 'Опыт: менее 1 года';
      else if (data === 'ord_exp_1_3') experience = 'Опыт: 1-3 года';
      else if (data === 'ord_exp_3_5') experience = 'Опыт: 3-5 лет';
      else if (data === 'ord_exp_5_10') experience = 'Опыт: 5-10 лет';
      else if (data === 'ord_exp_more10') experience = 'Опыт: более 10 лет';

      userStates[userId].data.executorRequirements = experience;
      userStates[userId].step = 8;
      await askOrderStep8(chatId, userId);
    }
    return;
  }

  // Обработка кнопки "Пропустить требования" (Order Step 6)
  if (data === 'skip_order_requirements') {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 6) {
      userStates[userId].data.executorRequirements = null;
      userStates[userId].step = 7;
      await askOrderStep7(chatId, userId);
    }
    return;
  }

  // Обработка кнопок срока актуальности (Order Step 7)
  if (data.startsWith('ord_validity_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 7) {
      let validityPeriod = '';
      if (data === 'ord_validity_7') validityPeriod = '7 дней';
      else if (data === 'ord_validity_14') validityPeriod = '14 дней';
      else if (data === 'ord_validity_30') validityPeriod = '30 дней';

      userStates[userId].data.validityPeriod = validityPeriod;
      userStates[userId].step = 8;
      await askOrderStep8(chatId, userId);
    }
    return;
  }

  // Обработка кнопки "Назад" для Order
  if (data === 'order_back') {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order') {
      const currentStep = userStates[userId].step;
      if (currentStep > 1) {
        userStates[userId].step = currentStep - 1;
        const step = currentStep - 1;

        if (step === 1) await askOrderStep1(chatId, userId);
        else if (step === 2) await askOrderStep2(chatId, userId);
        else if (step === 3) await askOrderStep3(chatId, userId);
        else if (step === 4) await askOrderStep4(chatId, userId);
        else if (step === 5) await askOrderStep5(chatId, userId);
        else if (step === 6) await askOrderStep6(chatId, userId);
        else if (step === 7) await askOrderStep7(chatId, userId);
        else if (step === 8) await askOrderStep8(chatId, userId);
        else if (step === 9) await askOrderStep9(chatId, userId);
        else if (step === 10) await askOrderStep10(chatId, userId);
      }
    }
    return;
  }

  // Обработка кнопок главного меню (inline)
  if (data === 'search_contractor') {
    // Удаляем меню
    if (liveMessages[chatId] && liveMessages[chatId].menuMessageId) {
      try {
        await safeDeleteMessage(chatId, liveMessages[chatId].menuMessageId);
      } catch (error) {
        console.log('Меню уже удалено');
      }
    }
    await bot.answerCallbackQuery(query.id);
    await startSearchProcess(chatId, userId);
    return;
  }

  // Навигация по результатам поиска
  if (data.startsWith('search_show_more_')) {
    const offset = parseInt(data.replace('search_show_more_', ''));
    await bot.answerCallbackQuery(query.id);
    await showSearchResults(chatId, userId, offset);
    return;
  }

  if (data === 'search_back') {
    await bot.answerCallbackQuery(query.id);
    delete searchStates[userId];
    await startSearchProcess(chatId, userId);
    return;
  }

  if (data === 'search_support') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, '📞 <b>Поддержка</b>\n\nНапиши свой вопрос, и мы постараемся помочь.', {
      parse_mode: 'HTML',
      ...communityKeyboard
    });
    return;
  }

  // Ищу работу - выбор между быстрым поиском и созданием анкеты
  if (data === 'search_work') {
    await bot.answerCallbackQuery(query.id);

    // ИСПРАВЛЕНИЕ: Очищаем все состояния при переходе в этот раздел
    if (userStates[userId]) {
      delete userStates[userId];
    }
    if (searchStates[userId]) {
      delete searchStates[userId];
    }

    // Удаляем меню
    await safeDeleteMessage(chatId, query.message.message_id);

    const menuText = `Как ты хочешь искать работу?

⚡️ Быстрый поиск — я покажу актуальные предложения по твоей анкете.

📝 Создать анкету — ты заполняешь профиль, и заказчики находят тебя сами в сообществе.

ℹ️ Сейчас ты можешь создать до 2 анкет специалиста.`;

    await bot.sendMessage(chatId, menuText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚡️ Быстрый поиск работы', callback_data: 'quick_search_work' }],
          [{ text: '📝 Создать анкету', callback_data: 'create_contractor_profile' }],
          [{ text: '🏠 В меню', callback_data: 'main_menu' }]
        ]
      }
    });
    return;
  }

  // Создать анкету подрядчика
  if (data === 'create_contractor_profile') {
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    // ИСПРАВЛЕНИЕ: Очищаем состояние быстрого поиска если оно есть
    if (searchStates[userId]) {
      delete searchStates[userId];
    }

    // Проверяем количество существующих анкет пользователя
    const { data: existingProfiles, error: checkError } = await supabase
      .from('contractors')
      .select('id')
      .eq('telegram_id', userId);

    if (checkError) {
      console.error('Ошибка проверки количества анкет:', checkError);
    }

    // Если уже есть 2 или больше анкет - показываем ошибку
    if (existingProfiles && existingProfiles.length >= 2) {
      await bot.sendMessage(chatId, `❌ У тебя уже есть максимальное количество анкет (2).

Чтобы создать новую, нужно сначала удалить одну из существующих.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📌 Моя анкета', callback_data: 'my_profile' }],
            [{ text: '🏠 В меню', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    const confirmText = `🔧 Отлично!

Сейчас мы создадим твою карточку подрядчика.
Процесс займёт 1–2 минуты.

Начнём?`;

    await bot.sendMessage(chatId, confirmText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Да, начать', callback_data: 'start_form' }],
          [{ text: '❌ Отмена', callback_data: 'cancel_form' }]
        ]
      }
    });
    return;
  }

  // Быстрый поиск работы (для специалистов)
  if (data === 'quick_search_work') {
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    // ИСПРАВЛЕНИЕ: Очищаем состояние создания анкеты если оно есть
    if (userStates[userId]) {
      delete userStates[userId];
    }

    // Проверяем наличие анкеты специалиста
    const { data: contractorData, error: contractorError } = await supabase
      .from('contractors')
      .select('*')
      .eq('telegram_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (contractorError || !contractorData) {
      // Анкеты нет - показываем сообщение
      const noProfileText = `Чтобы я мог показывать тебе подходящие предложения,
мне нужно знать твою специализацию и город.

Заполни анкету —
она публикуется в сообществе и помогает заказчикам находить тебя.`;

      await bot.sendMessage(chatId, noProfileText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 Создать анкету', callback_data: 'create_contractor_profile' }],
            [{ text: '🏠 В меню', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    // Анкета есть - показываем выбор города (Шаг 1)
    const cityText = `📍 Шаг 1 из 3 — Город

В каком городе ищешь работу?

<i>Выбери из кнопок или напиши свой город</i>`;

    const cityPromptMsg = await bot.sendMessage(chatId, cityText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Москва', callback_data: 'quick_search_city_Москва' }],
          [{ text: 'Санкт-Петербург', callback_data: 'quick_search_city_Санкт-Петербург' }],
          [{ text: 'Любой город', callback_data: 'quick_search_city_Любой город' }],
          [{ text: '◀️ Назад', callback_data: 'search_work' }],
          [{ text: '🏠 В меню', callback_data: 'main_menu' }]
        ]
      }
    });

    // Инициализируем состояние поиска (Шаг 1: ожидание города)
    searchStates[userId] = {
      type: 'search_orders',
      step: 'waiting_city',
      promptMessageId: cityPromptMsg.message_id
    };

    return;
  }

  // Навигация по карточкам заявок - следующая
  if (data.startsWith('next_order_')) {
    const newIndex = parseInt(data.replace('next_order_', ''));
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);
    await showOrderCards(chatId, userId, newIndex);
    return;
  }

  // Навигация по карточкам заявок - предыдущая
  if (data.startsWith('prev_order_')) {
    const newIndex = parseInt(data.replace('prev_order_', ''));
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);
    await showOrderCards(chatId, userId, newIndex);
    return;
  }

  // Навигация по карточкам специалистов - следующий
  if (data.startsWith('next_contractor_')) {
    const newIndex = parseInt(data.replace('next_contractor_', ''));
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);
    await showContractorCards(chatId, userId, newIndex);
    return;
  }

  // Навигация по карточкам специалистов - предыдущий
  if (data.startsWith('prev_contractor_')) {
    const newIndex = parseInt(data.replace('prev_contractor_', ''));
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);
    await showContractorCards(chatId, userId, newIndex);
    return;
  }

  // Обработка выбора города в быстром поиске работы
  if (data.startsWith('quick_search_city_')) {
    const selectedCity = data.replace('quick_search_city_', '');
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    // Сохраняем выбранный город и переходим к шагу 2
    if (!searchStates[userId]) {
      searchStates[userId] = {};
    }

    searchStates[userId].city = selectedCity;
    searchStates[userId].type = 'search_orders';
    searchStates[userId].step = 'waiting_work_format';

    // Показываем форму выбора формата работы (Шаг 2)
    const formatText = `Шаг 2 из 3 — Формат работы

Вы работаете как:`;

    const formatPromptMsg = await bot.sendMessage(chatId, formatText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Специалист', callback_data: 'quick_work_format_specialist' }],
          [{ text: 'Бригада', callback_data: 'quick_work_format_team' }],
          [{ text: 'Компания/подрядчик', callback_data: 'quick_work_format_company' }],
          [{ text: '◀️ Назад', callback_data: 'quick_search_work' }],
          [{ text: '🏠 В меню', callback_data: 'main_menu' }]
        ]
      }
    });

    searchStates[userId].promptMessageId = formatPromptMsg.message_id;
    return;
  }

  // Обработка выбора формата работы в быстром поиске работы
  if (data.startsWith('quick_work_format_')) {
    const formatType = data.replace('quick_work_format_', '');
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    if (!searchStates[userId]) {
      searchStates[userId] = {};
    }

    let workFormat = '';
    if (formatType === 'specialist') workFormat = 'Специалист';
    else if (formatType === 'team') workFormat = 'Бригада';
    else if (formatType === 'company') workFormat = 'Компания/подрядчик';

    searchStates[userId].workFormat = workFormat;
    searchStates[userId].step = 'waiting_query';

    // Показываем форму описания работы (Шаг 3)
    const searchText = `Шаг 3 из 3 — Описание работы

Напишите вашу специальность, профессию или опишите род деятельности.`;

    const searchPromptMsg = await bot.sendMessage(chatId, searchText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '◀️ Назад', callback_data: 'quick_search_work' }],
          [{ text: '🏠 В меню', callback_data: 'main_menu' }]
        ]
      }
    });

    searchStates[userId].promptMessageId = searchPromptMsg.message_id;
    return;
  }

  // Обработка выбора города в быстром поиске специалистов
  if (data.startsWith('quick_search_contractors_city_')) {
    const selectedCity = data.replace('quick_search_contractors_city_', '');
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    // Сохраняем выбранный город и переходим к шагу 2
    if (!searchStates[userId]) {
      searchStates[userId] = {};
    }

    searchStates[userId].city = selectedCity;
    searchStates[userId].type = 'search_contractors';
    searchStates[userId].step = 'waiting_format';

    // Показываем форму выбора формата (Шаг 2)
    const formatText = `Шаг 2 из 3 — Формат работы

Кого вы ищете?`;

    const formatPromptMsg = await bot.sendMessage(chatId, formatText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Специалиста', callback_data: 'quick_contractors_format_specialist' }],
          [{ text: 'Бригаду', callback_data: 'quick_contractors_format_team' }],
          [{ text: 'Компанию/подрядчика', callback_data: 'quick_contractors_format_company' }],
          [{ text: '◀️ Назад', callback_data: 'quick_search_contractors' }],
          [{ text: '🏠 В меню', callback_data: 'main_menu' }]
        ]
      }
    });

    searchStates[userId].promptMessageId = formatPromptMsg.message_id;
    return;
  }

  // Обработка выбора формата работы в быстром поиске специалистов
  if (data.startsWith('quick_contractors_format_')) {
    const formatType = data.replace('quick_contractors_format_', '');
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    if (!searchStates[userId]) {
      searchStates[userId] = {};
    }

    let workFormat = '';
    if (formatType === 'specialist') workFormat = 'Специалиста';
    else if (formatType === 'team') workFormat = 'Бригаду';
    else if (formatType === 'company') workFormat = 'Компанию/подрядчика';

    searchStates[userId].workFormat = workFormat;
    searchStates[userId].step = 'waiting_query';

    // Показываем форму описания специалистов (Шаг 3)
    const searchText = `🔍 Шаг 3 из 3 — Описание специалистов

Опиши, каких специалистов ты ищешь.

Можно:
— написать текстом

Я подберу специалистов из Базы по твоему запросу.

Пример:
«Нужен плиточник для квартиры»`;

    const searchPromptMsg = await bot.sendMessage(chatId, searchText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '◀️ Назад', callback_data: 'quick_search_contractors' }],
          [{ text: '🏠 В меню', callback_data: 'main_menu' }]
        ]
      }
    });

    searchStates[userId].promptMessageId = searchPromptMsg.message_id;
    return;
  }

  // Ищу людей - выбор между быстрым поиском и созданием заявки
  if (data === 'search_people') {
    await bot.answerCallbackQuery(query.id);

    // ИСПРАВЛЕНИЕ: Очищаем все состояния при переходе в этот раздел
    if (userStates[userId]) {
      delete userStates[userId];
    }
    if (searchStates[userId]) {
      delete searchStates[userId];
    }

    // Удаляем меню
    await safeDeleteMessage(chatId, query.message.message_id);

    const menuText = `Как ты хочешь найти специалистов?

⚡️ Быстрый поиск специалистов — мгновенное отображение специалистов по твоему запросу.

🧾 Создать заявку — заполни анкету, и специалисты сами свяжутся с тобой.

ℹ️ Сейчас ты можешь создать до 2 заявок на поиск специалистов.`;

    await bot.sendMessage(chatId, menuText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚡️ Быстрый поиск специалистов', callback_data: 'quick_search_contractors' }],
          [{ text: '🧾 Создать заявку', callback_data: 'create_order' }],
          [{ text: '🏠 В меню', callback_data: 'main_menu' }]
        ]
      }
    });
    return;
  }

  // Создать заявку
  if (data === 'create_order') {
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    // ИСПРАВЛЕНИЕ: Очищаем состояние быстрого поиска если оно есть
    if (searchStates[userId]) {
      delete searchStates[userId];
    }

    // Проверяем количество существующих заявок пользователя
    const { data: existingOrders, error: checkError } = await supabase
      .from('orders')
      .select('id')
      .eq('telegram_id', userId);

    if (checkError) {
      console.error('Ошибка проверки количества заявок:', checkError);
    }

    // Если уже есть 2 или больше заявок - показываем ошибку
    if (existingOrders && existingOrders.length >= 2) {
      await bot.sendMessage(chatId, `❌ У тебя уже есть максимальное количество заявок (2).

Чтобы создать новую, нужно сначала удалить одну из существующих.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📌 Моя анкета', callback_data: 'my_profile' }],
            [{ text: '🏠 В меню', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    const confirmText = `Ты можешь создать до <b>2 активных заявок</b> на поиск специалистов.

Заявка будет опубликована в сообществе «Голос Стройки».
<i>Контакты будут доступны специалистам только через Базу.</i>`;

    await bot.sendMessage(chatId, confirmText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Да, начать', callback_data: 'start_order_form' }],
          [{ text: '❌ Отмена', callback_data: 'cancel_form' }]
        ]
      }
    });
    return;
  }

  // Быстрый поиск специалистов (для заказчиков) - Шаг 1: Выбор города
  if (data === 'quick_search_contractors') {
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    // ИСПРАВЛЕНИЕ: Очищаем состояние создания анкеты если оно есть
    if (userStates[userId]) {
      delete userStates[userId];
    }

    // Показываем выбор города (Шаг 1)
    const cityText = `📍 Шаг 1 из 3 — Город

В каком городе ищешь специалистов?

<i>Выбери из кнопок или напиши свой город</i>`;

    const cityPromptMsg = await bot.sendMessage(chatId, cityText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Москва', callback_data: 'quick_search_contractors_city_Москва' }],
          [{ text: 'Санкт-Петербург', callback_data: 'quick_search_contractors_city_Санкт-Петербург' }],
          [{ text: 'Любой город', callback_data: 'quick_search_contractors_city_Любой город' }],
          [{ text: '◀️ Назад', callback_data: 'search_people' }],
          [{ text: '🏠 В меню', callback_data: 'main_menu' }]
        ]
      }
    });

    // Инициализируем состояние поиска (Шаг 1: ожидание города)
    searchStates[userId] = {
      type: 'search_contractors',
      step: 'waiting_city',
      promptMessageId: cityPromptMsg.message_id
    };

    return;
  }

  // Мой профиль / заявка
  if (data === 'my_profile') {
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    // Получаем анкеты пользователя
    const { data: contractorProfiles, error: contractorError } = await supabase
      .from('contractors')
      .select('*')
      .eq('telegram_id', userId)
      .order('created_at', { ascending: false });

    // Получаем заявки пользователя
    const { data: orderProfiles, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('telegram_id', userId)
      .order('created_at', { ascending: false });

    const contractorCount = contractorProfiles ? contractorProfiles.length : 0;
    const orderCount = orderProfiles ? orderProfiles.length : 0;

    let profileText = '📋 <b>Мои данные в Базе</b>\n\n';

    if (contractorCount > 0) {
      profileText += `👤 <b>Анкеты подрядчика:</b> ${contractorCount} из 2\n`;
    } else {
      profileText += `👤 Анкет подрядчика: 0 из 2\n`;
    }

    if (orderCount > 0) {
      profileText += `🧾 <b>Заявок:</b> ${orderCount} из 2\n`;
    } else {
      profileText += `🧾 Заявок: 0 из 2\n`;
    }

    const buttons = [];

    // Кнопки для анкет подрядчика
    if (contractorCount > 0) {
      buttons.push([{ text: '👤 Мои анкеты подрядчика', callback_data: 'view_my_contractors' }]);
    }

    // Кнопки для заявок
    if (orderCount > 0) {
      buttons.push([{ text: '🧾 Мои заявки', callback_data: 'view_my_orders' }]);
    }

    buttons.push([{ text: '🏠 В меню', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, profileText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buttons
      }
    });
    return;
  }

  // Просмотр анкет подрядчика
  if (data === 'view_my_contractors') {
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    const { data: contractorProfiles, error } = await supabase
      .from('contractors')
      .select('*')
      .eq('telegram_id', userId)
      .order('created_at', { ascending: false });

    if (!contractorProfiles || contractorProfiles.length === 0) {
      await bot.sendMessage(chatId, '❌ У тебя нет анкет подрядчика.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 В меню', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    let listText = '👤 <b>Твои анкеты подрядчика:</b>\n\n';
    const buttons = [];

    contractorProfiles.forEach((profile, index) => {
      const statusEmoji = profile.status === 'approved' ? '✅' : (profile.status === 'pending' ? '⏳' : '❌');
      listText += `${index + 1}. ${statusEmoji} ${profile.name} - ${profile.category}\n`;
      buttons.push([
        { text: `${index + 1}. ${profile.name}`, callback_data: `view_contractor_${profile.id}` }
      ]);
    });

    buttons.push([{ text: '◀️ Назад', callback_data: 'my_profile' }]);
    buttons.push([{ text: '🏠 В меню', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, listText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buttons
      }
    });
    return;
  }

  // Просмотр заявок
  if (data === 'view_my_orders') {
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    const { data: orderProfiles, error } = await supabase
      .from('orders')
      .select('*')
      .eq('telegram_id', userId)
      .neq('status', 'expired')
      .order('created_at', { ascending: false });

    if (!orderProfiles || orderProfiles.length === 0) {
      await bot.sendMessage(chatId, '❌ У тебя нет активных заявок.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 В меню', callback_data: 'main_menu' }]
          ]
        }
      });
      return;
    }

    let listText = '🧾 <b>Твои заявки:</b>\n\n';
    const buttons = [];

    orderProfiles.forEach((order, index) => {
      const statusEmoji = order.status === 'approved' ? '✅' : (order.status === 'pending' ? '⏳' : '❌');
      listText += `${index + 1}. ${statusEmoji} ${order.company_name} - ${order.category}\n`;
      buttons.push([
        { text: `${index + 1}. ${order.company_name}`, callback_data: `view_order_${order.id}` }
      ]);
    });

    buttons.push([{ text: '◀️ Назад', callback_data: 'my_profile' }]);
    buttons.push([{ text: '🏠 В меню', callback_data: 'main_menu' }]);

    await bot.sendMessage(chatId, listText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buttons
      }
    });
    return;
  }

  // Просмотр конкретной анкеты подрядчика
  if (data.startsWith('view_contractor_')) {
    const contractorId = data.replace('view_contractor_', '');
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    const { data: contractor, error } = await supabase
      .from('contractors')
      .select('*')
      .eq('id', contractorId)
      .eq('telegram_id', userId)
      .single();

    if (!contractor) {
      await bot.sendMessage(chatId, '❌ Анкета не найдена.');
      return;
    }

    // Получаем роль специалиста
    const userRole = await checkUserRole(userId);
    const cardText = formatContractorCard(contractor, userRole);
    const statusText = contractor.status === 'approved' ? '✅ Опубликована' :
                       (contractor.status === 'pending' ? '⏳ На модерации' : '❌ Отклонена');

    const fullText = `<b>Статус:</b> ${statusText}\n\n${cardText}`;
    const buttons = [
      [{ text: '🗑 Удалить анкету', callback_data: `delete_contractor_${contractorId}` }],
      [{ text: '◀️ Назад', callback_data: 'view_my_contractors' }],
      [{ text: '🏠 В меню', callback_data: 'main_menu' }]
    ];

    // Отправляем только текст анкеты с кнопками (фото не отображаются)
    await bot.sendMessage(chatId, fullText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: buttons
      }
    });
    return;
  }

  // Просмотр конкретной заявки
  if (data.startsWith('view_order_')) {
    const orderId = data.replace('view_order_', '');
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('telegram_id', userId)
      .single();

    if (!order) {
      await bot.sendMessage(chatId, '❌ Заявка не найдена.');
      return;
    }

    // Получаем роль компании
    const companyRole = await checkUserRole(userId);
    const cardText = formatOrderCard(order, companyRole);
    const statusText = order.status === 'approved' ? '✅ Опубликована' :
                       (order.status === 'pending' ? '⏳ На модерации' : '❌ Отклонена');

    await bot.sendMessage(chatId, `<b>Статус:</b> ${statusText}\n\n${cardText}`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑 Удалить заявку', callback_data: `delete_order_${orderId}` }],
          [{ text: '◀️ Назад', callback_data: 'view_my_orders' }],
          [{ text: '🏠 В меню', callback_data: 'main_menu' }]
        ]
      }
    });
    return;
  }

  // Удаление анкеты подрядчика
  if (data.startsWith('delete_contractor_')) {
    const contractorId = data.replace('delete_contractor_', '');
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    await bot.sendMessage(chatId, '⚠️ Ты уверен, что хочешь удалить эту анкету?\n\nЭто действие нельзя отменить.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Да, удалить', callback_data: `confirm_delete_contractor_${contractorId}` }],
          [{ text: '❌ Отмена', callback_data: `view_contractor_${contractorId}` }]
        ]
      }
    });
    return;
  }

  // Подтверждение удаления анкеты
  if (data.startsWith('confirm_delete_contractor_')) {
    const contractorId = data.replace('confirm_delete_contractor_', '');
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    const { error } = await supabase
      .from('contractors')
      .delete()
      .eq('id', contractorId)
      .eq('telegram_id', userId);

    if (error) {
      console.error('Ошибка удаления анкеты:', error);
      await bot.sendMessage(chatId, '❌ Ошибка при удалении анкеты. Попробуй позже.');
      return;
    }

    const successMsg = await bot.sendMessage(chatId, '✅ Анкета успешно удалена.');
    deleteMessageAfterDelay(chatId, successMsg.message_id, 5000);

    // Возвращаемся к списку анкет
    setTimeout(() => {
      bot.sendMessage(chatId, 'Перейди в "Моя анкета" чтобы увидеть обновленный список.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📌 Моя анкета', callback_data: 'my_profile' }],
            [{ text: '🏠 В меню', callback_data: 'main_menu' }]
          ]
        }
      });
    }, 1000);
    return;
  }

  // Удаление заявки
  if (data.startsWith('delete_order_')) {
    const orderId = data.replace('delete_order_', '');
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    await bot.sendMessage(chatId, '⚠️ Ты уверен, что хочешь удалить эту заявку?\n\nЭто действие нельзя отменить.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Да, удалить', callback_data: `confirm_delete_order_${orderId}` }],
          [{ text: '❌ Отмена', callback_data: `view_order_${orderId}` }]
        ]
      }
    });
    return;
  }

  // Подтверждение удаления заявки
  if (data.startsWith('confirm_delete_order_')) {
    const orderId = data.replace('confirm_delete_order_', '');
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);

    const { error } = await supabase
      .from('orders')
      .delete()
      .eq('id', orderId)
      .eq('telegram_id', userId);

    if (error) {
      console.error('Ошибка удаления заявки:', error);
      await bot.sendMessage(chatId, '❌ Ошибка при удалении заявки. Попробуй позже.');
      return;
    }

    const successMsg = await bot.sendMessage(chatId, '✅ Заявка успешно удалена.');
    deleteMessageAfterDelay(chatId, successMsg.message_id, 5000);

    // Возвращаемся к списку заявок
    setTimeout(() => {
      bot.sendMessage(chatId, 'Перейди в "Моя анкета" чтобы увидеть обновленный список.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📌 Моя анкета', callback_data: 'my_profile' }],
            [{ text: '🏠 В меню', callback_data: 'main_menu' }]
          ]
        }
      });
    }, 1000);
    return;
  }

  if (data === 'send_complaint') {
    await bot.answerCallbackQuery(query.id);

    // Удаляем меню
    await safeDeleteMessage(chatId, query.message.message_id);

    // Инициализируем состояние жалобы
    complaintStates[userId] = { active: true };

    const complaintMsg = await bot.sendMessage(chatId, '📝 Напиши свою жалобу, и мы её рассмотрим.\n\n<i>Минимум 10 символов</i>', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '◀️ Назад', callback_data: 'complaint_back' }]
        ]
      }
    });

    // Сохраняем ID сообщения для возможного удаления позже
    complaintStates[userId].messageId = complaintMsg.message_id;
    return;
  }

  if (data === 'faq_help') {
    await bot.answerCallbackQuery(query.id);
    // Удаляем предыдущее сообщение (главное меню или ответ на вопрос)
    await safeDeleteMessage(chatId, query.message.message_id);

    const faqText = `Этот бот — База сообщества «Голос Стройки».

Здесь:
— специалисты находят работу
— заказчики находят людей
— контакты доступны только в Базе

Анкеты и заявки публикуются в сообществе
без контактов и без флуда.

Если возникают вопросы или сложности,
пиши: @arrtproduction`;

    await bot.sendMessage(chatId, faqText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 В меню', callback_data: 'main_menu' }]
        ]
      }
    });
    return;
  }

  // Обработка кнопки "Назад в меню"
  if (data === 'back_to_main_menu') {
    await bot.answerCallbackQuery(query.id);
    await safeDeleteMessage(chatId, query.message.message_id);
    await showMainMenu(chatId);
    return;
  }

  // Обработка кнопки "Назад" в процессе жалобы
  if (data === 'complaint_back') {
    await bot.answerCallbackQuery(query.id);

    // Удаляем состояние жалобы если оно есть
    if (complaintStates[userId]) {
      delete complaintStates[userId];
    }

    // Удаляем сообщение с просьбой написать жалобу
    await safeDeleteMessage(chatId, query.message.message_id);

    // Возвращаемся в главное меню
    await showMainMenu(chatId);
    return;
  }

  await bot.answerCallbackQuery(query.id);
});

// ==================== ПРОЦЕСС ПОИСКА ====================

async function startSearchProcess(chatId, userId) {
  searchStates[userId] = {
    step: 1,
    city: null,
    workType: null
  };

  const text = `🏙 <b>Поиск подрядчика</b>

Напиши город, в котором ищешь подрядчика:

<i>Например: Москва, Санкт-Петербург, Казань</i>`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        [{ text: '❌ Отменить поиск' }]
      ],
      resize_keyboard: true
    }
  });
}

async function askWorkType(chatId, userId) {
  const text = `🔧 <b>Какой тип работ нужен?</b>

Опиши, какие работы нужно выполнить:

<i>Например: отделка квартиры, укладка плитки, малярные работы</i>`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        [{ text: '❌ Отменить поиск' }]
      ],
      resize_keyboard: true
    }
  });
}

async function performSearch(chatId, userId) {
  const searchData = searchStates[userId];

  await bot.sendMessage(chatId, '⏳ Подбираю подрядчиков...', communityKeyboard);

  try {
    // Поиск в базе данных
    const { data: contractors, error } = await supabase
      .from('contractors')
      .select('*')
      .eq('status', 'approved')
      .ilike('city', `%${searchData.city}%`)
      .ilike('specialization', `%${searchData.workType}%`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Ошибка поиска:', error);
      await bot.sendMessage(chatId, '❌ Произошла ошибка при поиске. Попробуй позже.', communityKeyboard);
      delete searchStates[userId];
      return;
    }

    if (!contractors || contractors.length === 0) {
      await bot.sendMessage(
        chatId,
        `😔 К сожалению, по запросу <b>"${searchData.workType}"</b> в городе <b>"${searchData.city}"</b> подрядчики не найдены.\n\nПопробуй изменить параметры поиска.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Новый поиск', callback_data: 'search_back' }]
            ]
          }
        }
      );
      delete searchStates[userId];
      return;
    }

    // Сохраняем результаты поиска
    searchStates[userId].results = contractors;
    searchStates[userId].totalCount = contractors.length;

    // Показываем первые 3 результата
    await showSearchResults(chatId, userId, 0);

  } catch (error) {
    console.error('Критическая ошибка поиска:', error);
    await bot.sendMessage(chatId, '❌ Произошла ошибка при поиске. Попробуй позже.', communityKeyboard);
    delete searchStates[userId];
  }
}

async function showSearchResults(chatId, userId, offset) {
  const searchData = searchStates[userId];

  if (!searchData || !searchData.results) {
    await bot.sendMessage(chatId, '❌ Результаты поиска не найдены. Начни поиск заново.', communityKeyboard);
    return;
  }

  const results = searchData.results;
  const totalCount = searchData.totalCount;
  const limit = 3;
  const contractors = results.slice(offset, offset + limit);

  if (contractors.length === 0) {
    await bot.sendMessage(chatId, '📄 Все результаты показаны.', communityKeyboard);
    return;
  }

  // Заголовок с количеством найденных
  const headerText = offset === 0
    ? `🎯 По вашему запросу найдено <b>${totalCount}</b> ${totalCount === 1 ? 'специалист' : totalCount < 5 ? 'специалиста' : 'специалистов'}.\n\nВот ${contractors.length === 1 ? 'первый' : `первые ${contractors.length}`}:`
    : `📄 Показываю еще ${contractors.length} ${contractors.length === 1 ? 'специалиста' : 'специалистов'}:`;

  await bot.sendMessage(chatId, headerText, { parse_mode: 'HTML' });

  // Отправляем карточки подрядчиков
  for (const contractor of contractors) {
    // Получаем роль специалиста (если доступно)
    const userRole = contractor.telegram_id ? await checkUserRole(contractor.telegram_id) : null;
    const cardText = formatContractorCard(contractor, userRole);

    // Отправляем только текст анкеты (фото не отображаются)
    await bot.sendMessage(chatId, cardText, { parse_mode: 'HTML', disable_web_page_preview: true });
  }

  // Кнопки навигации
  const buttons = [];

  if (offset + limit < totalCount) {
    buttons.push([{ text: '👉 Показать еще подрядчиков', callback_data: `search_show_more_${offset + limit}` }]);
  }

  buttons.push([{ text: '◀️ Вернуться к выбору услуги', callback_data: 'search_back' }]);
  buttons.push([{ text: '❓ Написать в поддержку', callback_data: 'search_support' }]);

  await bot.sendMessage(chatId, '━━━━━━━━━━━━━━━', {
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

function formatContractorCard(contractor, userRole = null) {
  const tripsText = contractor.ready_for_trips ? ' — готов к командировкам' : '';
  const advantages = contractor.professional_advantages || '';

  // Убираем дубль @ если telegram_tag уже содержит @
  const telegramTag = contractor.telegram_tag ?
    (contractor.telegram_tag.startsWith('@') ? contractor.telegram_tag : `@${contractor.telegram_tag}`) :
    'не указан';

  // Формируем роль с эмодзи (если роль передана)
  const roleEmoji = getRoleEmoji(userRole);

  // Используем область работ вместо категории
  const displayWorkArea = contractor.work_area || contractor.category || contractor.specialization;

  // Хук (если есть)
  const hookLine = contractor.hook ? `${contractor.hook}\n\n` : '';

  // Формируем ссылку на портфолио, если есть фото и channel_post_id
  const hasPortfolio = contractor.portfolio_photos && contractor.portfolio_photos.length > 0 && contractor.channel_post_id;
  const portfolioLine = hasPortfolio
    ? `📸 <b><u>Портфолио:</u></b> <a href="https://t.me/${COMMUNITY_CHANNEL_NAME}/${contractor.channel_post_id}">Посмотреть портфолио</a>\n`
    : '';

  return `📊 <b>ИЩЕТ РАБОТУ</b>
━━━━━━━━━━━
${hookLine}${contractor.name} | ${displayWorkArea}${roleEmoji}
━━━━━━━━━━━

🔧 <b><u>Специализация:</u></b> ${contractor.specialization}
💼 <b><u>Формат работы:</u></b> ${contractor.work_format}
📍 <b><u>Город / регион:</u></b> ${contractor.city}${tripsText}
⏱ <b><u>Опыт:</u></b> ${contractor.experience}
🏗 <b><u>Задачи / объекты:</u></b> ${contractor.objects_worked}
${advantages ? `⭐️ <b><u>Преимущества:</u></b> ${advantages}\n` : ''}📋 <b><u>Оформление:</u></b> ${contractor.cooperation_format}
${portfolioLine}
━━━━━━━━━━━
📞 ${contractor.contact} | ${telegramTag}`;
}

function formatOrderCard(order, companyRole = null) {
  const requirements = order.executor_requirements || '';

  // Убираем дубль @ если telegram_tag уже содержит @
  const telegramTag = order.telegram_tag ?
    (order.telegram_tag.startsWith('@') ? order.telegram_tag : `@${order.telegram_tag}`) :
    'не указан';

  // Формируем роль с эмодзи (если роль передана)
  const roleEmoji = getRoleEmoji(companyRole);

  // Используем область работ вместо категории
  const displayWorkArea = order.work_area || order.category || order.request_type;

  // Хук (если есть)
  const hookLine = order.hook ? `${order.hook}\n\n` : '';

  return `📊 <b>ИЩУТ СОТРУДНИКА</b>
━━━━━━━━━━━
${hookLine}${order.company_name}${roleEmoji}
━━━━━━━━━━━

🔍 <b><u>Ищут специалиста:</u></b> ${displayWorkArea}
🏢 <b><u>Заказчик:</u></b> ${order.company_name}
📍 <b><u>Город / объект:</u></b> ${order.city_location}

📝 <b><u>Задача:</u></b> ${order.work_type}
${requirements ? `✅ <b><u>Требования:</u></b> ${requirements}\n` : ''}━━━━━━━━━━━
📞 ${order.contact} | ${telegramTag}`;
}

// ==================== ФУНКЦИИ ФОРМАТИРОВАНИЯ ДЛЯ КАНАЛА ====================

// Форматирование поста специалиста для канала (БЕЗ контактов)
function formatChannelContractorPost(contractor, contractorId) {
  const tripsText = contractor.ready_for_trips ? ' — готов к командировкам' : '';
  const advantages = contractor.professional_advantages || '';

  // Роль с эмодзи (если есть)
  const roleEmoji = getRoleEmoji(contractor.role);

  // Используем область работ вместо категории
  const displayWorkArea = contractor.work_area || contractor.category || contractor.specialization;

  // Хук (если есть)
  const hookLine = contractor.hook ? `${contractor.hook}\n\n` : '';

  // Формируем deep link ссылку на бота с ID анкеты
  const botLink = `<a href="https://t.me/${BOT_USERNAME}?start=contractor_${contractorId}">Базе сообщества</a>`;

  return `📊 <b>ИЩЕТ РАБОТУ</b>
━━━━━━━━━━━
${hookLine}${contractor.name} | ${displayWorkArea}${roleEmoji}
━━━━━━━━━━━

🔧 <b><u>Специализация:</u></b> ${contractor.specialization}
💼 <b><u>Формат работы:</u></b> ${contractor.work_format}
📍 <b><u>Город / регион:</u></b> ${contractor.city}${tripsText}
⏱ <b><u>Опыт:</u></b> ${contractor.experience}
🏗 <b><u>Задачи / объекты:</u></b> ${contractor.objects_worked}
${advantages ? `⭐️ <b><u>Преимущества:</u></b> ${advantages}\n` : ''}📋 <b><u>Оформление:</u></b> ${contractor.cooperation_format}

━━━━━━━━━━━
☎️ Контакты этого специалиста и другие предложения —
доступны в ${botLink}`;
}

// Форматирование поста заявки для канала (БЕЗ контактов)
function formatChannelOrderPost(order, orderId) {
  const requirements = order.executor_requirements || '';

  // Используем область работ вместо категории
  const displayWorkArea = order.work_area || order.category || order.request_type;

  // Роль с эмодзи (если есть)
  const roleEmoji = getRoleEmoji(order.role);

  // Хук (если есть)
  const hookLine = order.hook ? `${order.hook}\n\n` : '';

  // Формируем deep link ссылку на бота с ID заявки
  const botLink = `<a href="https://t.me/${BOT_USERNAME}?start=order_${orderId}">Базе сообщества</a>`;

  return `📊 <b>ИЩУТ СОТРУДНИКА</b>
━━━━━━━━━━━
${hookLine}${order.company_name}${roleEmoji}
━━━━━━━━━━━

🔍 <b><u>Ищут специалиста:</u></b> ${displayWorkArea}
🏢 <b><u>Заказчик:</u></b> ${order.company_name}
📍 <b><u>Город / объект:</u></b> ${order.city_location}

📝 <b><u>Задача:</u></b> ${order.work_type}
${requirements ? `✅ <b><u>Требования:</u></b> ${requirements}\n` : ''}━━━━━━━━━━━
☎️ Контакты этого заказчика и другие предложения —
доступны в ${botLink}`;
}

// ==================== ФУНКЦИИ ПУБЛИКАЦИИ В КАНАЛ ====================

// Публикация анкеты специалиста в канал
async function publishContractorToChannel(contractor, contractorId) {
  try {
    console.log(`📤 Публикация анкеты специалиста ${contractorId} в канал...`);

    // Форматируем текст для канала с deep link
    const postText = formatChannelContractorPost(contractor, contractorId);

    let sentMessage;
    const photos = contractor.portfolio_photos || [];

    // Отправляем в зависимости от количества фото
    if (photos.length === 0) {
      // Нет фото - только текст
      sentMessage = await bot.sendMessage(CHANNEL_ID, postText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        message_thread_id: CONTRACTORS_THREAD_ID
      });
    } else if (photos.length === 1) {
      // Одно фото - sendPhoto с caption
      sentMessage = await bot.sendPhoto(CHANNEL_ID, photos[0], {
        caption: postText,
        parse_mode: 'HTML',
        message_thread_id: CONTRACTORS_THREAD_ID
      });
    } else {
      // Несколько фото (2-6) - медиагруппа
      const media = photos.slice(0, 6).map((photoId, index) => ({
        type: 'photo',
        media: photoId,
        ...(index === 0 ? { caption: postText, parse_mode: 'HTML' } : {})
      }));

      const sentMessages = await bot.sendMediaGroup(CHANNEL_ID, media, {
        message_thread_id: CONTRACTORS_THREAD_ID
      });
      sentMessage = sentMessages[0]; // Берём первое сообщение из группы
    }

    // Получаем message_id
    const messageId = sentMessage.message_id;
    console.log(`✅ Пост опубликован, message_id: ${messageId}`);

    // Сохраняем в базу
    const { error } = await supabase
      .from('contractors')
      .update({ channel_post_id: messageId })
      .eq('id', contractorId);

    if (error) {
      console.error('❌ Ошибка сохранения channel_post_id:', error.message);
    } else {
      console.log(`✅ channel_post_id сохранён в базу для анкеты ${contractorId}`);
    }

    return messageId;
  } catch (error) {
    console.error('❌ Ошибка публикации анкеты в канал:', error.message);
    // НЕ прерываем создание анкеты - просто логируем ошибку
    return null;
  }
}

// Публикация заявки в канал
async function publishOrderToChannel(order, orderId) {
  try {
    console.log(`📤 Публикация заявки ${orderId} в канал...`);

    // Форматируем текст для канала с deep link
    const postText = formatChannelOrderPost(order, orderId);

    // У заявок нет фото - только текст
    const sentMessage = await bot.sendMessage(CHANNEL_ID, postText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      message_thread_id: ORDERS_THREAD_ID
    });

    // Получаем message_id
    const messageId = sentMessage.message_id;
    console.log(`✅ Пост опубликован, message_id: ${messageId}`);

    // Сохраняем в базу
    const { error } = await supabase
      .from('orders')
      .update({ channel_post_id: messageId })
      .eq('id', orderId);

    if (error) {
      console.error('❌ Ошибка сохранения channel_post_id:', error.message);
    } else {
      console.log(`✅ channel_post_id сохранён в базу для заявки ${orderId}`);
    }

    return messageId;
  } catch (error) {
    console.error('❌ Ошибка публикации заявки в канал:', error.message);
    // НЕ прерываем создание заявки - просто логируем ошибку
    return null;
  }
}

// Функция показа карточек заявок (для специалистов)
async function showOrderCards(chatId, userId, currentIndex) {
  const searchData = searchStates[userId];

  if (!searchData || !searchData.results || searchData.results.length === 0) {
    await bot.sendMessage(chatId, '❌ Результаты поиска не найдены. Начни поиск заново.');
    return;
  }

  const orders = searchData.results;
  const currentOrder = orders[currentIndex];

  if (!currentOrder) {
    await bot.sendMessage(chatId, '❌ Заявка не найдена.');
    return;
  }

  // Получаем роль компании (если доступно)
  const companyRole = currentOrder.company_user_id ? await checkUserRole(currentOrder.company_user_id) : null;

  // Формируем текст карточки с номером
  const cardText = `📊 <b>Результат ${currentIndex + 1} из ${orders.length}</b>\n\n${formatOrderCard(currentOrder, companyRole)}`;

  // Формируем кнопки навигации
  const buttons = [];

  // Кнопки навигации по карточкам
  const navButtons = [];
  if (currentIndex > 0) {
    navButtons.push({ text: '◀️ Предыдущее', callback_data: `prev_order_${currentIndex - 1}` });
  }
  if (currentIndex < orders.length - 1) {
    navButtons.push({ text: '▶️ Следующее', callback_data: `next_order_${currentIndex + 1}` });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  // Кнопка в меню
  buttons.push([{ text: '🏠 В меню', callback_data: 'main_menu' }]);

  await bot.sendMessage(chatId, cardText, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

// Функция показа карточек специалистов (для заказчиков)
async function showContractorCards(chatId, userId, currentIndex) {
  const searchData = searchStates[userId];

  if (!searchData || !searchData.results || searchData.results.length === 0) {
    await bot.sendMessage(chatId, '❌ Результаты поиска не найдены. Начни поиск заново.');
    return;
  }

  const contractors = searchData.results;
  const currentContractor = contractors[currentIndex];

  if (!currentContractor) {
    await bot.sendMessage(chatId, '❌ Специалист не найден.');
    return;
  }

  // Получаем роль специалиста (если доступно)
  const userRole = currentContractor.telegram_id ? await checkUserRole(currentContractor.telegram_id) : null;

  // Формируем текст карточки с номером
  const cardText = `📊 <b>Результат ${currentIndex + 1} из ${contractors.length}</b>\n\n${formatContractorCard(currentContractor, userRole)}`;

  // Формируем кнопки навигации
  const buttons = [];

  // Кнопки навигации по карточкам
  const navButtons = [];
  if (currentIndex > 0) {
    navButtons.push({ text: '◀️ Предыдущий', callback_data: `prev_contractor_${currentIndex - 1}` });
  }
  if (currentIndex < contractors.length - 1) {
    navButtons.push({ text: '▶️ Следующий', callback_data: `next_contractor_${currentIndex + 1}` });
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons);
  }

  // Кнопка создать заявку
  buttons.push([{ text: '🧾 Создать заявку', callback_data: 'create_order' }]);

  // Кнопка в меню
  buttons.push([{ text: '🏠 В меню', callback_data: 'main_menu' }]);

  // Отправляем только текст анкеты с кнопками (фото не отображаются)
  await bot.sendMessage(chatId, cardText, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

// ==================== ПРОЦЕСС АНКЕТЫ ====================

async function startFormProcess(chatId, userId, username) {
  // Инициализируем состояние пользователя для ветки contractors
  userStates[userId] = {
    formType: 'contractor',
    step: 1,
    chatId,
    username: username || 'неизвестен',
    data: {}
  };

  await askStep1(chatId, userId);
}

// ==================== ВЕТКА: ОБЪЕКТ/ЗАКАЗ ====================

async function startOrderFormProcess(chatId, userId, username) {
  // Инициализируем состояние для ветки orders
  userStates[userId] = {
    formType: 'order',
    step: 1,
    chatId,
    username: username || 'неизвестен',
    data: {}
  };

  await askOrderStep1(chatId, userId);
}

// Шаг 1 - Формат работы (специалист/бригада/компания)
async function askStep1(chatId, userId) {
  const text = `Шаг 1 из 11 — Формат работы

Вы работаете как:`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Отправляем основное сообщение с инлайн-кнопками
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Специалист', callback_data: 'wf_specialist' }],
        [{ text: 'Бригада', callback_data: 'wf_brigade' }],
        [{ text: 'Компания', callback_data: 'wf_company' }],
        [{ text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 2 - Специализация (было шаг 3)
async function askStep2(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 2);

  const text = `${formData}Шаг 2 из 11 — Специализация

Напиши свою основную специализацию.`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Отправляем основное сообщение с инлайн-кнопками
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 3 - Город/регион + готовность к командировкам (было шаг 2)
async function askStep3(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 3);

  // Определяем состояние переключателя командировок
  const readyForTrips = userData.readyForTrips || false;
  const tripsToggle = readyForTrips ? '✅ ГОТОВ К КОМАНДИРОВКАМ' : '☐ ГОТОВ К КОМАНДИРОВКАМ';

  const text = `${formData}Шаг 3 из 11 — Город/регион

Напиши, в каком городе ты работаешь,
или выбери из кнопок ниже.

Также отметь, готов ли ты к командировкам.`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Отправляем основное сообщение с инлайн-кнопками
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: tripsToggle, callback_data: 'toggle_trips' }],
        [{ text: 'Москва', callback_data: 'city_moscow' }],
        [{ text: 'Санкт-Петербург', callback_data: 'city_spb' }],
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 4 - Имя (НОВЫЙ ШАГ)
async function askStep4(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 4);

  const text = `${formData}Шаг 4 из 11 — Имя

Напиши, как к тебе обращаться.`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Отправляем основное сообщение с инлайн-кнопками
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 5 - Опыт работы (было шаг 4)
async function askStep5(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 5);

  const text = `${formData}Шаг 5 из 11 — Опыт работы

Укажи свой опыт работы в этой сфере.`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Отправляем основное сообщение с инлайн-кнопками
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Менее 1 года', callback_data: 'exp_less1' }, { text: '1-3 года', callback_data: 'exp_1_3' }],
        [{ text: '3-5 лет', callback_data: 'exp_3_5' }, { text: '5-10 лет', callback_data: 'exp_5_10' }],
        [{ text: 'Более 10 лет', callback_data: 'exp_more10' }],
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 6 - На каких объектах работали (было шаг 5)
async function askStep6(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 6);

  const text = `${formData}Шаг 6 из 11 — Задачи и объекты

Опиши, с какими задачами и объектами ты работаешь.

<i>Можно:</i>
— написать текстом

Я приведу информацию в аккуратный и понятный вид.

<i>Пример:</i>
<i>«Отделка квартир под ключ, санузлы, кухни. Объекты 50–120 м².»</i>`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Отправляем основное сообщение с инлайн-кнопками
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 7 - Профессиональные преимущества (НОВЫЙ ШАГ - необязательный)
async function askStep7(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 7);

  const text = `${formData}Шаг 7 из 11 — Профессиональные преимущества

Если хочешь, укажи профессиональные преимущества.

Здесь важно то, что реально отличает тебя в работе, например:
— узкая специализация
— редкие навыки
— допуски, сертификаты, лицензии
— опыт на сложных объектах
— собственная команда или оборудование

<i>Можно написать текстом
// или отправить голосовое сообщение —
я приведу его в аккуратный и понятный вид.</i>

<i>Пример:</i>
<i>«Опыт работы с коммерческими объектами, допуск к высотным работам.»</i>`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Отправляем основное сообщение с инлайн-кнопками
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⏭ Пропустить', callback_data: 'skip_advantages' }],
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 8 - Формат сотрудничества (было шаг 7, переименовано из documents_form)
async function askStep8(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 8);

  const text = `${formData}Шаг 8 из 11 — Формат сотрудничества

Укажи, в каком формате ты работаешь.

<i>Это поможет заказчикам понять,
как с тобой можно сотрудничать.</i>`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Отправляем основное сообщение с инлайн-кнопками
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'ИП', callback_data: 'coop_ip' }],
        [{ text: 'Самозанятый', callback_data: 'coop_samozanyaty' }],
        [{ text: 'ООО', callback_data: 'coop_ooo' }],
        [{ text: 'По договору', callback_data: 'coop_contract' }],
        [{ text: 'Без оформления', callback_data: 'coop_none' }],
        [{ text: 'Любой формат', callback_data: 'coop_any' }],
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 9 - Условия оплаты (было шаг 8)
async function askStep9(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 9);

  const text = `${formData}💰 Шаг 9 из 11 — Условия оплаты

Как принимаешь оплату?

<i>Выбери из кнопок или напиши свой вариант</i>`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Отправляем основное сообщение с инлайн-кнопками
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Нал', callback_data: 'payment_cash' }],
        [{ text: 'Безнал', callback_data: 'payment_cashless' }],
        [{ text: 'Обсуждается', callback_data: 'payment_negotiable' }],
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 10 - Контакты (было шаг 9)
async function askStep10(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 10);

  const text = `${formData}Шаг 10 из 11 — Контакты

Укажи контактный номер телефона,
по которому заказчики смогут с тобой связаться.

<i>Ты можешь:</i>
— написать номер вручную
— или нажать кнопку ниже, чтобы поделиться контактом`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Отправляем основное сообщение с обычной клавиатурой
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        [{ text: '📱 Поделиться контактом', request_contact: true }],
        [{ text: '◀️ Назад' }, { text: '❌ Отменить заполнение' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 11 - Фото (было шаг 10)
async function askStep11(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 11);

  const text = `${formData}Шаг 11 из 11 — Портфолио

Добавь фото или видео своих работ <i>(до 6 шт.)</i>.

Это поможет заказчикам быстрее понять твой уровень
и ускорит поиск работы.

<i>Можно пропустить.</i>

Нажимая кнопку «Завершить», вы принимаете <a href="${process.env.PRIVACY_POLICY_URL}">политику конфиденциальности</a>.`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  // Инициализируем массив портфолио если его нет
  if (!userData.portfolio) {
    userData.portfolio = [];
  }

  const portfolioCount = userData.portfolio.length;
  const buttonText = portfolioCount > 0
    ? `✅ Завершить (${portfolioCount} фото)`
    : '✅ Завершить без фото';

  // Отправляем основное сообщение с инлайн-кнопками
  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: buttonText, callback_data: 'confirm_form' }],
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ],
      remove_keyboard: true
    }
  });

  // Сохраняем ID нового сообщения
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Завершение анкеты
async function finishForm(chatId, userId, telegramUsername) {
  const userData = userStates[userId];

  // НОВОЕ: Получаем роль из БД вместо временного хранилища
  const userRole = await checkUserRole(userId);

  // Генерируем хук через AI
  const hook = await generateContractorHook({
    specialization: userData.data.specialization,
    experience: userData.data.experience,
    professionalAdvantages: userData.data.professionalAdvantages,
    objectsWorked: userData.data.objectsWorked,
    workFormat: userData.data.workFormat,
    readyForTrips: userData.data.readyForTrips || false
  });

  // Сохраняем в базу данных (этап 5: добавлена категория)
  const result = await saveContractorToDatabase({
    userId,
    username: userData.username,
    workFormat: userData.data.workFormat,
    specialization: userData.data.specialization,
    city: userData.data.city,
    readyForTrips: userData.data.readyForTrips || false, // этап 3
    name: userData.data.name, // этап 3
    experience: userData.data.experience,
    objectsWorked: userData.data.objectsWorked,
    professionalAdvantages: userData.data.professionalAdvantages || null, // этап 3
    cooperationFormat: userData.data.cooperationFormat, // этап 3: переименовано
    paymentConditions: userData.data.paymentConditions,
    contact: userData.data.contact,
    photoUrl: (userData.data.portfolio && userData.data.portfolio.length > 0) ? userData.data.portfolio[0] : null, // Первое фото из портфолио (для обратной совместимости)
    portfolio: userData.data.portfolio || [], // Весь массив фотографий портфолио
    telegramTag: telegramUsername ? `@${telegramUsername}` : null,
    category: userData.data.category || null, // этап 5: AI-определенная категория
    workArea: userData.data.workArea || null, // Область работ на основе категории
    role: userRole || null, // этап 2: получаем роль из таблицы user_roles
    hook: hook || null // Добавляем сгенерированный хук
  });

  if (result.success) {
    // Публикуем анкету в канал
    try {
      // Используем данные из базы, чтобы убедиться, что все поля присутствуют
      const savedContractor = result.data[0];

      await publishContractorToChannel(savedContractor, savedContractor.id);
    } catch (error) {
      console.error('❌ Ошибка публикации в канал:', error.message);
      // НЕ прерываем - публикация не критична для пользователя
    }

    const successText = `Готово ✅
Твоя анкета добавлена в Базу сообщества
и опубликована в сообществе «Голос Стройки».

Теперь:
— заказчики могут находить тебя в Базе
— ты можешь смотреть актуальные предложения по своей специализации`;

    await bot.sendMessage(chatId, successText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔁 Заполнить ещё одну анкету', callback_data: 'search_work' }],
          [{ text: '🏠 В главное меню', callback_data: 'main_menu' }]
        ]
      }
    });
  } else {
    await bot.sendMessage(chatId, '❌ Произошла ошибка при сохранении данных. Попробуй позже.', mainMenuKeyboard);
    await showMainMenu(chatId);
  }

  // Очищаем состояние
  delete userStates[userId];
}

// Завершение анкеты Order
async function finishOrderForm(chatId, userId) {
  const userData = userStates[userId];

  // НОВОЕ: Получаем роль из БД вместо временного хранилища
  const userRole = await checkUserRole(userId);

  // Генерируем хук через AI
  const hook = await generateOrderHook({
    requestType: userData.data.requestType,
    cityLocation: userData.data.cityLocation,
    objectType: userData.data.objectType,
    workType: userData.data.workType,
    executorRequirements: userData.data.executorRequirements,
    validityPeriod: userData.data.validityPeriod
  });

  // Сохраняем в базу данных (этап 5: добавлена категория)
  const result = await saveOrderToDatabase({
    userId,
    username: userData.username,
    requestType: userData.data.requestType,
    cityLocation: userData.data.cityLocation,
    objectType: userData.data.objectType,
    workType: userData.data.workType,
    executorRequirements: userData.data.executorRequirements,
    validityPeriod: userData.data.validityPeriod,
    companyName: userData.data.companyName,
    contact: userData.data.contact,
    telegramTag: userData.data.telegramTag,
    category: userData.data.category || null, // этап 5: AI-определенная категория
    workArea: userData.data.workArea || null, // Область работ на основе категории
    role: userRole || null, // этап 2: получаем роль из таблицы user_roles
    hook: hook || null // Добавляем сгенерированный хук
  });

  if (result.success) {
    // Публикуем заявку в канал
    try {
      const orderData = {
        ...userData.data,
        hook: hook,
        role: userRole,
        category: userData.data.category,
        company_name: userData.data.companyName,
        city_location: userData.data.cityLocation,
        work_type: userData.data.workType,
        executor_requirements: userData.data.executorRequirements
      };

      await publishOrderToChannel(orderData, result.data[0].id);
    } catch (error) {
      console.error('❌ Ошибка публикации заявки в канал:', error.message);
      // НЕ прерываем - публикация не критична для пользователя
    }

    const successText = `Готово ✅
Твоя заявка опубликована в сообществе «Голос Стройки».

Специалисты будут находить её в Базе и связываться с тобой напрямую.`;

    try {
      await bot.sendMessage(chatId, successText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Добавить ещё один запрос', callback_data: 'search_people' }],
            [{ text: '🏠 В главное меню', callback_data: 'main_menu' }]
          ]
        }
      });
    } catch (error) {
      console.error('❌ Ошибка отправки сообщения после сохранения заявки:', error.message);
      // Пробуем отправить хотя бы простое сообщение
      try {
        await bot.sendMessage(chatId, successText);
      } catch (retryError) {
        console.error('❌ Повторная ошибка отправки сообщения:', retryError.message);
      }
    }
  } else {
    try {
      await bot.sendMessage(chatId, '❌ Произошла ошибка при сохранении данных. Попробуй позже.', mainMenuKeyboard);
      await showMainMenu(chatId);
    } catch (error) {
      console.error('❌ Ошибка отправки сообщения об ошибке:', error.message);
    }
  }

  // Очищаем состояние
  delete userStates[userId];
}

// Завершение анкеты Supplier
// ==================== ШАГИ ДЛЯ ВЕТКИ ORDER (ОБЪЕКТ/ЗАКАЗ) ====================

// Шаг 1 Order - Тип запроса
async function askOrderStep1(chatId, userId) {
  const text = `Шаг 1 из 10 — Формат работы

Кого вы ищете?`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Специалиста', callback_data: 'ord_format_specialist' }],
        [{ text: 'Бригаду', callback_data: 'ord_format_team' }],
        [{ text: 'Компанию/подрядчика', callback_data: 'ord_format_company' }],
        [{ text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 2 Order - Специализация (кого ищешь)
async function askOrderStep2(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 <b>Твоя заявка:</b>\n\n';

  if (userData.workFormat) formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}👷 Шаг 2 из 10 — Кого ты ищешь?

Напиши специализацию своими словами.

<i>Пример: "Монтажник вент. фасадов" или "Бригада каменщиков"</i>`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 3 Order - Город и локация объекта
async function askOrderStep3(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 <b>Твоя заявка:</b>\n\n';

  if (userData.workFormat) formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;
  if (userData.requestType) formText += `2️⃣ Кого ищешь: ${userData.requestType}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}Шаг 3 из 10 — Город и локация объекта

Напиши город, в котором нужно выполнить работу,
или выбери из кнопок ниже.`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Москва', callback_data: 'ord_city_moscow' }],
        [{ text: 'Санкт-Петербург', callback_data: 'ord_city_spb' }],
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 4 Order - Тип объекта
async function askOrderStep4(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 <b>Твоя заявка:</b>\n\n';

  if (userData.workFormat) formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;
  if (userData.requestType) formText += `2️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `3️⃣ Город: ${userData.cityLocation}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}Шаг 4 из 10 — Тип объекта

На каком объекте нужно выполнить работу?
Напиши свой вариант или выбери из списка.`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Квартира', callback_data: 'ord_obj_apartment' }],
        [{ text: 'Частный дом', callback_data: 'ord_obj_house' }],
        [{ text: 'Коммерческий объект', callback_data: 'ord_obj_commercial' }],
        [{ text: 'Промышленный объект', callback_data: 'ord_obj_industrial' }],
        [{ text: 'Дороги / инфраструктура', callback_data: 'ord_obj_roads' }],
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 5 Order - Описание задачи (объединено: работы + объём)
async function askOrderStep5(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 <b>Твоя заявка:</b>\n\n';

  if (userData.workFormat) formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;
  if (userData.requestType) formText += `2️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `3️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `4️⃣ Тип объекта: ${userData.objectType}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}📝 Шаг 5 из 10 — Описание задачи

Опиши задачу.
Что нужно сделать?
С чего начинается работа?
Сколько специалистов требуется?

Можно написать текстом.

<i>Пример:</i>
<i>«Нужно уложить плитку в санузле, стены и пол.
Площадь около 20 м², нужен 1 человек.»</i>`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 6 Order - Требования к исполнителю (было шаг 5, добавлена кнопка "Пропустить")
async function askOrderStep6(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 <b>Твоя заявка:</b>\n\n';

  if (userData.workFormat) formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;
  if (userData.requestType) formText += `2️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `3️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `4️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `5️⃣ Описание задачи: ${userData.workType.substring(0, 50)}...\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}👤 Шаг 6 из 10 — Требования к исполнителю

Если есть особые требования — укажи их здесь.
Например: опыт, собственное оборудование, допуски, квалификации.

Если требований нет — пропусти шаг.`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⏭ Пропустить', callback_data: 'skip_order_requirements' }],
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 7 Order - Срок актуальности
async function askOrderStep7(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 <b>Твоя заявка:</b>\n\n';

  if (userData.workFormat) formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;
  if (userData.requestType) formText += `2️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `3️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `4️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `5️⃣ Описание задачи: ${userData.workType.substring(0, 50)}...\n`;
  if (userData.executorRequirements) formText += `6️⃣ Требования: ${userData.executorRequirements}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}⏰ Шаг 7 из 10 — Срок актуальности

Сколько дней заявка актуальна? По истечению срока заявка скроется и откликов не будет.

Напиши свой вариант или выбери из кнопок.`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '7 дней', callback_data: 'ord_validity_7' }],
        [{ text: '14 дней', callback_data: 'ord_validity_14' }],
        [{ text: '30 дней', callback_data: 'ord_validity_30' }],
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 8 Order - Имя или название компании
async function askOrderStep8(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 <b>Твоя заявка:</b>\n\n';

  if (userData.workFormat) formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;
  if (userData.requestType) formText += `2️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `3️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `4️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `5️⃣ Задача: ${userData.workType}\n`;
  if (userData.executorRequirements) formText += `6️⃣ Требования: ${userData.executorRequirements}\n`;
  if (userData.validityPeriod) formText += `7️⃣ Срок актуальности: ${userData.validityPeriod}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}👤 Шаг 8 из 10 — Имя или название компании

Напиши имя или название компании —
это будет видно специалистам.

<i>Примеры:</i>
<i>"Иван" или "ООО Стройпроект"</i>`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 9 Order - Контактный номер телефона
async function askOrderStep9(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 <b>Твоя заявка:</b>\n\n';

  if (userData.workFormat) formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;
  if (userData.requestType) formText += `2️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `3️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `4️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `5️⃣ Задача: ${userData.workType}\n`;
  if (userData.executorRequirements) formText += `6️⃣ Требования: ${userData.executorRequirements}\n`;
  if (userData.validityPeriod) formText += `7️⃣ Срок актуальности: ${userData.validityPeriod}\n`;
  if (userData.companyName) formText += `8️⃣ Компания: ${userData.companyName}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}Шаг 9 из 10 — Контактный номер телефона

Напиши контактный телефон
или нажми кнопку «Поделиться контактом».`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        [{ text: '📱 Поделиться контактом', request_contact: true }],
        [{ text: '◀️ Назад' }, { text: '❌ Отменить заполнение' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 10 Order - Финальное согласование (проверка данных)
async function askOrderStep10(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 <b>Твоя заявка:</b>\n\n';

  if (userData.workFormat) formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;
  if (userData.requestType) formText += `2️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `3️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `4️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `5️⃣ Задача: ${userData.workType}\n`;
  if (userData.executorRequirements) formText += `6️⃣ Требования: ${userData.executorRequirements}\n`;
  if (userData.validityPeriod) formText += `7️⃣ Срок актуальности: ${userData.validityPeriod}\n`;
  if (userData.companyName) formText += `8️⃣ Компания: ${userData.companyName}\n`;
  if (userData.contact) formText += `9️⃣ Контакт: ${userData.contact}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `Шаг 10 из 10 — Проверка заявки

<b>Проверь заявку перед публикацией:</b>

${formText}
Заявка будет опубликована в сообществе «Голос Стройки».
<i>Специалисты смогут связаться с тобой через Базу.</i>

Нажимая кнопку «Подтвердить», вы принимаете <a href="${process.env.PRIVACY_POLICY_URL}">политику конфиденциальности</a>.`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Подтвердить', callback_data: 'confirm_order_form' }],
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// ==================== ОБРАБОТКА СООБЩЕНИЙ ====================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  // Игнорируем сообщения из каналов и групп - работаем только в личных чатах
  if (msg.chat.type !== 'private') {
    return;
  }

  // Пропускаем команды
  if (text && text.startsWith('/')) return;

  // Проверяем, отправляет ли пользователь жалобу
  if (complaintStates[userId]) {
    // Удаляем сообщение пользователя
    try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

    // Проверяем валидацию ПЕРЕД удалением сообщения с просьбой
    if (!text || text.trim().length < 10) {
      const errorMsg = await bot.sendMessage(chatId, '❌ Жалоба слишком короткая. Опиши проблему подробнее (минимум 10 символов).');
      deleteMessageAfterDelay(chatId, errorMsg.message_id);
      return;
    }

    // Удаляем сообщение с просьбой написать жалобу только если валидация прошла
    if (complaintStates[userId].messageId) {
      try {
        await safeDeleteMessage(chatId, complaintStates[userId].messageId);
      } catch (e) {}
    }

    // Получаем telegram username
    const telegramUsername = msg.from.username;

    // Сохраняем жалобу в БД
    const result = await saveComplaintToDatabase({
      userId: userId,
      contractorId: null,  // В будущем можно будет связывать с конкретным подрядчиком
      message: text.trim(),
      telegramTag: telegramUsername ? `@${telegramUsername}` : null
    });

    // Удаляем состояние жалобы
    delete complaintStates[userId];

    if (result.success) {
      // Форматируем текущую дату
      const now = new Date();
      const day = now.getDate();
      const month = now.toLocaleString('ru-RU', { month: 'long' });
      const year = now.getFullYear();
      const dateStr = `${day} ${month} ${year}`;

      await bot.sendMessage(chatId,
`✅ <b>Жалоба принята</b>

📝 Текст жалобы:
<i>${text.trim()}</i>

📅 Дата: ${dateStr}

Наш менеджер свяжется с вами для решения этого вопроса.

Спасибо за обратную связь!`,
        {
          parse_mode: 'HTML',
          ...mainMenuKeyboard
        }
      );
      // НЕ удаляем это сообщение
      await showMainMenu(chatId);
    } else {
      const failMsg = await bot.sendMessage(chatId, '❌ Произошла ошибка при отправке жалобы. Попробуй позже.', mainMenuKeyboard);
      deleteMessageAfterDelay(chatId, failMsg.message_id);
    }
    return;
  }

  // Проверяем, ищет ли пользователь подрядчика
  if (searchStates[userId]) {
    const state = searchStates[userId];

    // Отмена поиска
    if (text === '❌ Отменить поиск') {
      delete searchStates[userId];
      await bot.sendMessage(chatId, '❌ Поиск отменен.', communityKeyboard);
      await showMainMenu(chatId);
      return;
    }

    // Шаг 1 - город
    if (state.step === 1) {
      if (!text || text.trim().length < 2) {
        await bot.sendMessage(chatId, '❌ Название города слишком короткое. Попробуй еще раз.');
        return;
      }

      state.city = text.trim();
      state.step = 2;
      await askWorkType(chatId, userId);
      return;
    }

    // Шаг 2 - тип работ
    if (state.step === 2) {
      if (!text || text.trim().length < 3) {
        await bot.sendMessage(chatId, '❌ Опиши подробнее, какие работы нужны (минимум 3 символа).');
        return;
      }

      state.workType = text.trim();
      await performSearch(chatId, userId);
      return;
    }

    // Обработка ввода города в быстром поиске специалистов (Шаг 1)
    if (state.type === 'search_contractors' && state.step === 'waiting_city') {
      // Удаляем сообщение пользователя
      try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

      // Обработка города через Deepseek
      const processingContractorCityMsg = await bot.sendMessage(chatId, '🤖 Обрабатываю название города...');
      const processedContractorCity = await processCityWithDeepseek(text.trim());

      setTimeout(() => {
        safeDeleteMessage(chatId, processingContractorCityMsg.message_id).catch(() => {});
      }, 3000);

      // Если город не распознан - показываем ошибку и остаемся на текущем шаге
      if (!processedContractorCity) {
        const contractorCityErrorMsg = await bot.sendMessage(chatId, `❌ Не удалось распознать город.
Пожалуйста, укажи корректное название города.

Например:
✅ "Москва"
✅ "Санкт-Петербург"
✅ "Новосибирск"

❌ Не подходит:
"asdfgh"
"город"
"123"`);
        // Автоудаление через 30 секунд
        deleteMessageAfterDelay(chatId, contractorCityErrorMsg.message_id, 30000);
        // НЕ переходим на следующий шаг, остаемся на waiting_city
        return;
      }

      // Если город распознан - показываем результат
      if (processedContractorCity !== text.trim()) {
        const resultContractorCityMsg = await bot.sendMessage(chatId, `✨ Распознан город: ${processedContractorCity}`);
        setTimeout(() => {
          safeDeleteMessage(chatId, resultContractorCityMsg.message_id).catch(() => {});
        }, 3000);
      }

      // Удаляем сообщение с вопросом о городе
      if (state.promptMessageId) {
        try {
          await safeDeleteMessage(chatId, state.promptMessageId);
        } catch (e) {}
      }

      // Сохраняем город и переходим к шагу 2
      state.city = processedContractorCity;
      state.step = 'waiting_query';

      // Показываем форму описания специалистов (Шаг 2)
      const searchText = `🔍 Шаг 2 из 2 — Описание специалистов

Опиши, каких специалистов ты ищешь.

Можно:
— написать текстом

Я подберу специалистов из Базы по твоему запросу.

Пример:
«Нужен плиточник для квартиры»`;

      const searchPromptMsg = await bot.sendMessage(chatId, searchText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '◀️ Назад', callback_data: 'quick_search_contractors' }],
            [{ text: '🏠 В меню', callback_data: 'main_menu' }]
          ]
        }
      });

      state.promptMessageId = searchPromptMsg.message_id;
      return;
    }

    // Обработка быстрого поиска специалистов (Шаг 2)
    if (state.type === 'search_contractors' && state.step === 'waiting_query') {
      // Удаляем сообщение пользователя
      try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

      let userQuery = text;

      // Обработка голосового сообщения
      if (msg.voice) {
        const processingMsg = await bot.sendMessage(chatId, '🎤 Распознаю голосовое сообщение...');
        userQuery = await recognizeVoice(msg.voice.file_id);
        await safeDeleteMessage(chatId, processingMsg.message_id);

        if (!userQuery) {
          await bot.sendMessage(chatId, '❌ Не удалось распознать голос. Попробуй еще раз.' /* или напиши текстом. */);
          return;
        }

        await bot.sendMessage(chatId, `✅ Распознано: "${userQuery}"`);
      }

      // Показать сообщение "Анализирую запрос..."
      const analyzingMsg = await bot.sendMessage(chatId, '🤖 Анализирую запрос и подбираю специалистов...');

      // Определить категорию через AI с учетом формата работы
      const category = await determineCategoryWithAI(userQuery, searchStates[userId].workFormat);

      // Удаляем сообщение "Анализирую..."
      await safeDeleteMessage(chatId, analyzingMsg.message_id);

      if (!category) {
        // Категория не определена - НЕ удаляем меню, оставляем для повторной попытки
        const errorMsg = await bot.sendMessage(chatId, `❌ Не получилось понять, кого именно ты ищешь.
Попробуй описать точнее.

Например:
✅ "Нужен плиточник"
✅ "Ищу бригаду отделочников"
✅ "Требуется электрик"

❌ Не подходит:
"Нужны строители"
"Ищу рабочих"`);
        // Автоудаление через 30 секунд
        deleteMessageAfterDelay(chatId, errorMsg.message_id, 30000);
        // Остаёмся на том же шаге, меню НЕ удаляем
        return;
      }

      // Категория определена - ТЕПЕРЬ удаляем меню
      if (state.promptMessageId) {
        try {
          await safeDeleteMessage(chatId, state.promptMessageId);
        } catch (e) {}
      }

      // Категория определена - запускаем поиск с фильтрацией по городу
      const selectedCity = state.city; // Город, выбранный пользователем

      let contractorsData = [];
      let contractorsError = null;

      if (selectedCity && selectedCity !== 'Любой город') {
        // Если выбран конкретный город - получаем всех по категории и фильтруем в коде
        const { data: allContractors, error } = await supabase
          .from('contractors')
          .select('*')
          .eq('category', category)
          .eq('status', 'approved')
          .neq('telegram_id', userId)
          .order('created_at', { ascending: false });

        contractorsError = error;

        if (!error && allContractors) {
          // Фильтруем на стороне приложения:
          // 1. Город содержит выбранный город (например, "Москва")
          // 2. Город = "Любой город"
          // 3. ready_for_trips = true (готов к командировкам)

          console.log(`[DEBUG] Всего кандидатов по категории: ${allContractors.length}`);
          console.log(`[DEBUG] Фильтр по городу: "${selectedCity}"`);

          contractorsData = allContractors.filter(contractor => {
            const contractorCity = (contractor.city || '').toLowerCase();
            const selectedCityLower = selectedCity.toLowerCase();

            const cityMatch = contractorCity.includes(selectedCityLower);
            const anyCity = contractorCity.includes('готов работать в любом городе') || contractorCity.includes('любой город');
            const readyForTrips = contractor.ready_for_trips === true;

            const result = cityMatch || anyCity || readyForTrips;

            console.log(`[DEBUG] ID ${contractor.id}: city="${contractor.city}", ready_for_trips=${contractor.ready_for_trips}, result=${result} (cityMatch=${cityMatch}, anyCity=${anyCity}, readyForTrips=${readyForTrips})`);

            return result;
          });

          console.log(`[DEBUG] После фильтрации: ${contractorsData.length} кандидатов`);
        }
      } else {
        // Если выбран "Любой город" - показываем всех специалистов
        const { data, error } = await supabase
          .from('contractors')
          .select('*')
          .eq('category', category)
          .eq('status', 'approved')
          .neq('telegram_id', userId)
          .order('created_at', { ascending: false });

        contractorsData = data;
        contractorsError = error;
      }

      if (contractorsError || !contractorsData || contractorsData.length === 0) {
        // Специалистов нет
        const noResultsText = `По твоему запросу сейчас нет подходящих специалистов.

• Попробуй ввести другой запрос.

• Или создай заявку и специалисты сами свяжутся с тобой.`;

        await bot.sendMessage(chatId, noResultsText, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Ввести другой запрос', callback_data: 'search_specialist' }],
              [{ text: '🧾 Создать заявку', callback_data: 'create_order' }],
              [{ text: '🏠 В меню', callback_data: 'main_menu' }]
            ]
          }
        });

        // Очищаем состояние поиска
        delete searchStates[userId];
        return;
      }

      // Специалисты найдены - показываем первую карточку
      searchStates[userId] = {
        type: 'contractors',
        results: contractorsData
      };

      await showContractorCards(chatId, userId, 0);
      return;
    }

    // Обработка ввода города в быстром поиске заявок (Шаг 1)
    if (state.type === 'search_orders' && state.step === 'waiting_city') {
      // Удаляем сообщение пользователя
      try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

      // Обработка города через Deepseek
      const processingSearchCityMsg = await bot.sendMessage(chatId, '🤖 Обрабатываю название города...');
      const processedSearchCity = await processCityWithDeepseek(text.trim());

      setTimeout(() => {
        safeDeleteMessage(chatId, processingSearchCityMsg.message_id).catch(() => {});
      }, 3000);

      // Если город не распознан - показываем ошибку и остаемся на текущем шаге
      if (!processedSearchCity) {
        const searchCityErrorMsg = await bot.sendMessage(chatId, `❌ Не удалось распознать город.
Пожалуйста, укажи корректное название города.

Например:
✅ "Москва"
✅ "Санкт-Петербург"
✅ "Новосибирск"

❌ Не подходит:
"asdfgh"
"город"
"123"`);
        // Автоудаление через 30 секунд
        deleteMessageAfterDelay(chatId, searchCityErrorMsg.message_id, 30000);
        // НЕ переходим на следующий шаг, остаемся на waiting_city
        return;
      }

      // Если город распознан - показываем результат
      if (processedSearchCity !== text.trim()) {
        const resultSearchCityMsg = await bot.sendMessage(chatId, `✨ Распознан город: ${processedSearchCity}`);
        setTimeout(() => {
          safeDeleteMessage(chatId, resultSearchCityMsg.message_id).catch(() => {});
        }, 3000);
      }

      // Удаляем сообщение с вопросом о городе
      if (state.promptMessageId) {
        try {
          await safeDeleteMessage(chatId, state.promptMessageId);
        } catch (e) {}
      }

      // Сохраняем город и переходим к шагу 2
      state.city = processedSearchCity;
      state.step = 'waiting_query';

      // Показываем форму описания работы (Шаг 2)
      const searchText = `🔍 Шаг 2 из 2 — Описание работы

Опиши, какую работу ты ищешь.

Можно:
— написать текстом

Я подберу подходящие заявки из Базы по твоему запросу.

Пример:
«Ищу работу по укладке плитки»`;

      const searchPromptMsg = await bot.sendMessage(chatId, searchText, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '◀️ Назад', callback_data: 'quick_search_work' }],
            [{ text: '🏠 В меню', callback_data: 'main_menu' }]
          ]
        }
      });

      state.promptMessageId = searchPromptMsg.message_id;
      return;
    }

    // Обработка быстрого поиска заявок (для специалистов) - Шаг 2
    if (state.type === 'search_orders' && state.step === 'waiting_query') {
      // Удаляем сообщение пользователя
      try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

      let userQuery = text;

      // Обработка голосового сообщения
      if (msg.voice) {
        const processingMsg = await bot.sendMessage(chatId, '🎤 Распознаю голосовое сообщение...');
        userQuery = await recognizeVoice(msg.voice.file_id);
        await safeDeleteMessage(chatId, processingMsg.message_id);

        if (!userQuery) {
          await bot.sendMessage(chatId, '❌ Не удалось распознать голос. Попробуй еще раз.' /* или напиши текстом. */);
          return;
        }

        await bot.sendMessage(chatId, `✅ Распознано: "${userQuery}"`);
      }

      // Показать сообщение "Анализирую запрос..."
      const analyzingMsg = await bot.sendMessage(chatId, '🤖 Анализирую запрос и подбираю заявки...');

      // Определить категорию через AI с учетом формата работы
      const category = await determineCategoryWithAI(userQuery, searchStates[userId].workFormat);

      // Удаляем сообщение "Анализирую..."
      await safeDeleteMessage(chatId, analyzingMsg.message_id);

      if (!category) {
        // Категория не определена - НЕ удаляем меню, оставляем для повторной попытки
        const errorMsg = await bot.sendMessage(chatId, `❌ Не получилось понять, какую работу ты ищешь.
Попробуй описать точнее.

Например:
✅ "Ищу работу плиточником"
✅ "Нужна работа по отделке"
✅ "Ищу заказы на электромонтаж"

❌ Не подходит:
"Нужна работа"
"Ищу заказы"`);
        // Автоудаление через 30 секунд
        deleteMessageAfterDelay(chatId, errorMsg.message_id, 30000);
        // Остаёмся на том же шаге, меню НЕ удаляем
        return;
      }

      // Категория определена - ТЕПЕРЬ удаляем меню
      if (state.promptMessageId) {
        try {
          await safeDeleteMessage(chatId, state.promptMessageId);
        } catch (e) {}
      }

      // Категория определена - запускаем поиск с фильтрацией по городу
      const selectedCity = state.city; // Город, выбранный пользователем

      let ordersData;
      let ordersError;

      // Фильтр по городу - используем client-side фильтрацию
      if (selectedCity && selectedCity !== 'Любой город') {
        // Сначала получаем ВСЕ заявки по категории
        const { data: allOrders, error } = await supabase
          .from('orders')
          .select('*')
          .eq('category', category)
          .eq('status', 'approved')
          .neq('telegram_id', userId)
          .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
          .order('created_at', { ascending: false });

        ordersError = error;

        if (!error && allOrders) {
          // Затем фильтруем на клиенте
          ordersData = allOrders.filter(order => {
            const orderCity = (order.city_location || '').toLowerCase();
            const selectedCityLower = selectedCity.toLowerCase();

            // Показываем заявки:
            // 1. С выбранным городом
            // 2. С "Любой город"
            return (
              orderCity.includes(selectedCityLower) ||  // Город совпадает
              orderCity.includes('любой город')         // "Любой город"
            );
          });
        }
      } else {
        // Если выбран "Любой город" - показываем все заявки (без фильтра)
        const { data, error } = await supabase
          .from('orders')
          .select('*')
          .eq('category', category)
          .eq('status', 'approved')
          .neq('telegram_id', userId)
          .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
          .order('created_at', { ascending: false });

        ordersData = data;
        ordersError = error;
      }

      if (ordersError || !ordersData || ordersData.length === 0) {
        // Заявок нет
        const noOrdersText = `По твоей анкете сейчас нет активных предложений.

Это нормально — новые заявки появляются регулярно.

Твоя анкета уже опубликована в сообществе,
заказчики могут написать тебе напрямую.`;

        await bot.sendMessage(chatId, noOrdersText, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Создать анкету', callback_data: 'create_contractor_profile' }],
              [{ text: '🏠 В меню', callback_data: 'main_menu' }]
            ]
          }
        });

        // Очищаем состояние поиска
        delete searchStates[userId];
        return;
      }

      // Заявки найдены - показываем первую карточку
      searchStates[userId] = {
        type: 'orders',
        results: ordersData
      };

      await showOrderCards(chatId, userId, 0);
      return;
    }
  }

  // Проверяем, заполняет ли пользователь анкету
  if (userStates[userId]) {
    const state = userStates[userId];

    // Обработка кнопки "Назад" (только для шагов с контактами)
    if (text === '◀️ Назад') {
      if (state.formType === 'contractor' && state.step === 10) {
        state.step = 9;
        await askStep9(chatId, userId);
        return;
      } else if (state.formType === 'order' && state.step === 8) {
        state.step = 7;
        await askOrderStep7(chatId, userId);
        return;
      }
    }

    // Обработка кнопки "Отменить заполнение"
    if (text === '❌ Отменить заполнение') {
      delete userStates[userId];
      await bot.sendMessage(chatId, '❌ Заполнение анкеты отменено.', mainMenuKeyboard);
      await showMainMenu(chatId);
      return;
    }

    let responseText = text;

    // Обработка контакта (contractor шаг 10, order шаг 9)
    if (msg.contact && (
      (state.formType === 'contractor' && state.step === 10) ||
      (state.formType === 'order' && state.step === 9)
    )) {
      const contact = msg.contact;
      // Убираем лишний плюс если он уже есть в номере
      let phoneNumber = contact.phone_number;
      if (phoneNumber && !phoneNumber.startsWith('+')) {
        phoneNumber = '+' + phoneNumber;
      }
      responseText = phoneNumber || msg.from.username || 'unknown';
      const sentMsg = await bot.sendMessage(chatId, `✅ Контакт получен: ${responseText}`);
      deleteMessageAfterDelay(chatId, sentMsg.message_id);
    }


    // Флаг для отслеживания, был ли текст уже обработан через Deepseek
    let isTextProcessed = false;

    // Обработка голосового сообщения
    if (msg.voice) {
      await bot.sendMessage(chatId, '🎤 Распознаю голосовое сообщение...');
      responseText = await recognizeVoice(msg.voice.file_id);

      if (!responseText) {
        await bot.sendMessage(chatId, '❌ Не удалось распознать голос. Попробуй еще раз.' /* или напиши текстом. */);
        return;
      }

      await bot.sendMessage(chatId, `✅ Распознано: "${responseText}"`);

      // Обработка голосового текста через Deepseek для шагов 3 (специализация)
      if (state.step === 3) {
        const processingMsg = await bot.sendMessage(chatId, '🤖 Обрабатываю текст...');
        const processedText = await processTextWithDeepseek(responseText, 'specialization');

        // Удаляем сообщение "Обрабатываю текст..." через 3 секунды
        setTimeout(() => {
          safeDeleteMessage(chatId, processingMsg.message_id).catch(() => {});
        }, 3000);

        if (processedText !== responseText) {
          const resultMsg = await bot.sendMessage(chatId, `✨ Текст обработан:\n"${processedText}"`);
          responseText = processedText;
          isTextProcessed = true; // Помечаем, что текст уже обработан

          // Удаляем сообщение "Текст обработан..." через 3 секунды
          setTimeout(() => {
            safeDeleteMessage(chatId, resultMsg.message_id).catch(() => {});
          }, 3000);
        }
      }
    }

    // Проверка на пустой ответ (не применяется к шагу 11 - фото)
    if ((!responseText || responseText.trim() === '') && state.step !== 11) {
      await bot.sendMessage(chatId, '❌ Пожалуйста, введи текст');
      return;
    }

    // ========== ОБРАБОТКА ORDER ФОРМЫ ==========
    if (state.formType === 'order') {
      // Удаляем сообщение пользователя
      try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

      let validation;
      switch (state.step) {
        case 2: // Кого ищешь (свободный текстовый ввод)
          validation = validateWorkType(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }

          // Этап 5: Определение категории через AI с учетом формата работы
          const orderCategoryMsg = await bot.sendMessage(chatId, '🤖 Определяю категорию...');
          const orderCategory = await determineCategoryWithAI(responseText.trim(), state.data.workFormat);

          setTimeout(() => {
            safeDeleteMessage(chatId, orderCategoryMsg.message_id).catch(() => {});
          }, 2000);

          // Если категория не определена - показываем ошибку и остаемся на том же шаге
          if (!orderCategory) {
            const orderErrorMsg = await bot.sendMessage(chatId, `❌ Не получилось определить кого ты ищешь.
Попробуй написать точнее.

Например:
✅ "Плиточник"
✅ "Бригада штукатуров"
✅ "Монтажник вентиляции"

❌ Не подходит:
"Мастера"
"Работники"`);
            // НЕ переходим на следующий шаг, остаемся на шаге 2
            return;
          }

          state.data.requestType = responseText.trim();
          state.data.category = orderCategory; // Сохраняем категорию
          state.data.workArea = getWorkAreaByCategory(orderCategory); // Сохраняем область работ
          state.step = 3;
          await askOrderStep3(chatId, userId);
          break;

        case 3: // Город и локация
          validation = validateCityLocation(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }

          // Обработка города через Deepseek
          const processingOrderCityMsg = await bot.sendMessage(chatId, '🤖 Обрабатываю название города...');
          const processedOrderCity = await processCityWithDeepseek(responseText.trim());

          setTimeout(() => {
            safeDeleteMessage(chatId, processingOrderCityMsg.message_id).catch(() => {});
          }, 3000);

          // Если город не распознан - показываем ошибку и остаемся на текущем шаге
          if (!processedOrderCity) {
            try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
            const orderCityErrorMsg = await bot.sendMessage(chatId, `❌ Не удалось распознать город.
Пожалуйста, укажи корректное название города.

Например:
✅ "Москва"
✅ "Санкт-Петербург"
✅ "Новосибирск"

❌ Не подходит:
"asdfgh"
"город"
"123"`);
            // Автоудаление через 30 секунд
            deleteMessageAfterDelay(chatId, orderCityErrorMsg.message_id, 30000);
            // НЕ переходим на следующий шаг, остаемся на шаге 2
            return;
          }

          // Если город распознан - показываем результат
          if (processedOrderCity !== responseText.trim()) {
            const resultOrderCityMsg = await bot.sendMessage(chatId, `✨ Распознан город: ${processedOrderCity}`);
            setTimeout(() => {
              safeDeleteMessage(chatId, resultOrderCityMsg.message_id).catch(() => {});
            }, 3000);
          }

          state.data.cityLocation = processedOrderCity;
          state.step = 4;
          await askOrderStep4(chatId, userId);
          break;

        case 4: // Тип объекта (свободный ввод)
          validation = validateCityLocation(responseText); // Используем ту же валидацию
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.objectType = responseText.trim();
          state.step = 5;
          await askOrderStep5(chatId, userId);
          break;

        case 5: // Описание задачи (объединение старых шагов 4 и 5)
          validation = validateWorkType(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.workType = responseText.trim();
          state.step = 6;
          await askOrderStep6(chatId, userId);
          break;

        case 6: // Требования к исполнителю (необязательно)
          validation = validateExecutorRequirements(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.executorRequirements = responseText.trim();
          state.step = 7;
          await askOrderStep7(chatId, userId);
          break;

        case 7: // Срок актуальности (свободный ввод или кнопки)
          validation = validateCityLocation(responseText); // Базовая валидация
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.validityPeriod = responseText.trim();
          state.step = 8;
          await askOrderStep8(chatId, userId);
          break;

        case 8: // Имя или название компании
          validation = validateCompanyName(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.companyName = responseText.trim();
          state.step = 9;
          await askOrderStep9(chatId, userId);
          break;

        case 9: // Контактный телефон
          validation = validatePhoneNumber(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.contact = responseText.trim();

          // Автоматически сохраняем telegram username
          const telegramUsername = msg.from.username;
          state.data.telegramTag = telegramUsername ? `@${telegramUsername}` : null;

          // Переходим на финальное согласование
          state.step = 10;
          await askOrderStep10(chatId, userId);
          break;

        default:
          break;
      }
      return;
    }

    // ========== ОБРАБОТКА CONTRACTOR ФОРМЫ ==========
    // Валидация и сохранение данных по шагам
    let validation;
    switch (state.step) {
      case 1: // Формат работы
        validation = validateWorkFormat(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.workFormat = responseText.trim();
        state.step = 2;
        await askStep2(chatId, userId);
        break;

      case 2: // Специализация (было шаг 3)
        validation = validateSpecialization(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }

        let processedSpecialization = responseText.trim();

        // Обработка текста через Deepseek только если он еще не был обработан
        if (!isTextProcessed) {
          const processingMsg = await bot.sendMessage(chatId, '🤖 Обрабатываю текст...');
          processedSpecialization = await processTextWithDeepseek(responseText.trim(), 'specialization');

          setTimeout(() => {
            safeDeleteMessage(chatId, processingMsg.message_id).catch(() => {});
          }, 3000);

          if (processedSpecialization !== responseText.trim()) {
            const resultMsg = await bot.sendMessage(chatId, `✨ Текст обработан:\n"${processedSpecialization}"`);
            setTimeout(() => {
              safeDeleteMessage(chatId, resultMsg.message_id).catch(() => {});
            }, 3000);
          }
        }

        // Этап 5: Определение категории через AI
        const categoryMsg = await bot.sendMessage(chatId, '🤖 Определяю категорию...');
        const category = await determineCategoryWithAI(processedSpecialization, state.data.workFormat);

        setTimeout(() => {
          safeDeleteMessage(chatId, categoryMsg.message_id).catch(() => {});
        }, 2000);

        // Если категория не определена - показываем ошибку и остаемся на том же шаге
        if (!category) {
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          const errorMsg = await bot.sendMessage(chatId, `❌ Не получилось определить твою специализацию.
Попробуй написать точнее.

Например:
✅ "Укладываю плитку"
✅ "Монтаж вентиляции"
✅ "Отделка квартир под ключ"

❌ Не подходит:
"Делаю всё"
"Работаю в стройке"`);
          // Автоудаление через 30 секунд
          deleteMessageAfterDelay(chatId, errorMsg.message_id, 30000);
          // НЕ переходим на следующий шаг, остаемся на шаге 2
          return;
        }

        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.specialization = processedSpecialization;
        state.data.category = category; // Сохраняем категорию
        state.data.workArea = getWorkAreaByCategory(category); // Сохраняем область работ
        state.step = 3;
        await askStep3(chatId, userId);
        break;

      case 3: // Город (было шаг 2)
        validation = validateCity(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }

        // Обработка города через Deepseek
        const processingCityMsg = await bot.sendMessage(chatId, '🤖 Обрабатываю название города...');
        const processedCity = await processCityWithDeepseek(responseText.trim());

        setTimeout(() => {
          safeDeleteMessage(chatId, processingCityMsg.message_id).catch(() => {});
        }, 3000);

        // Если город не распознан - показываем ошибку и остаемся на текущем шаге
        if (!processedCity) {
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          const cityErrorMsg = await bot.sendMessage(chatId, `❌ Не удалось распознать город.
Пожалуйста, укажи корректное название города.

Например:
✅ "Москва"
✅ "Санкт-Петербург"
✅ "Новосибирск"

❌ Не подходит:
"asdfgh"
"город"
"123"`);
          // Автоудаление через 30 секунд
          deleteMessageAfterDelay(chatId, cityErrorMsg.message_id, 30000);
          // НЕ переходим на следующий шаг, остаемся на шаге 3
          return;
        }

        // Если город распознан - показываем результат
        if (processedCity !== responseText.trim()) {
          const resultCityMsg = await bot.sendMessage(chatId, `✨ Распознан город: ${processedCity}`);
          setTimeout(() => {
            safeDeleteMessage(chatId, resultCityMsg.message_id).catch(() => {});
          }, 3000);
        }

        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.city = processedCity;
        state.step = 4;
        await askStep4(chatId, userId);
        break;

      case 4: // Имя (НОВОЕ)
        if (!responseText || responseText.trim().length < 2) {
          const errMsg = await bot.sendMessage(chatId, '❌ Имя слишком короткое. Введи минимум 2 символа.');
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.name = responseText.trim();
        state.step = 5;
        await askStep5(chatId, userId);
        break;

      case 5: // Опыт работы (было шаг 4)
        validation = validateExperience(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.experience = responseText.trim();
        state.step = 6;
        await askStep6(chatId, userId);
        break;

      case 6: // На каких объектах работали (было шаг 5)
        validation = validateObjectsWorked(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.objectsWorked = responseText.trim();
        state.step = 7;
        await askStep7(chatId, userId);
        break;

      case 7: // Профессиональные преимущества (НОВОЕ, необязательное)
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.professionalAdvantages = responseText.trim();
        state.step = 8;
        await askStep8(chatId, userId);
        break;

      case 8: // Формат сотрудничества (было шаг 7, documentsForm)
        validation = validateDocumentsForm(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.cooperationFormat = responseText.trim();
        state.step = 9;
        await askStep9(chatId, userId);
        break;

      case 9: // Условия оплаты (было шаг 8)
        validation = validatePaymentConditions(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.paymentConditions = responseText.trim();
        state.step = 10;
        await askStep10(chatId, userId);
        break;

      case 10: // Контакты (было шаг 9)
        validation = validatePhoneNumber(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.contact = responseText.trim();
        state.step = 11;
        await askStep11(chatId, userId);
        break;

      case 11: // Портфолио
        if (msg.photo && msg.photo.length > 0) {
          // Инициализируем массив портфолио если его нет
          if (!state.data.portfolio) {
            state.data.portfolio = [];
          }

          // Проверяем лимит (максимум 6 фото)
          if (state.data.portfolio.length >= 6) {
            const limitMsg = await bot.sendMessage(chatId, '❌ Максимум 6 фото в портфолио. Нажми "Завершить" чтобы сохранить анкету.');
            deleteMessageAfterDelay(chatId, limitMsg.message_id, 5000);
            try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
            return;
          }

          const photo = msg.photo[msg.photo.length - 1];
          state.data.portfolio.push(photo.file_id);

          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

          const photoCount = state.data.portfolio.length;
          const confirmMsg = await bot.sendMessage(chatId, `✅ Фото ${photoCount} добавлено!\n\nМожешь добавить ещё ${6 - photoCount} фото или завершить заполнение.`);
          deleteMessageAfterDelay(chatId, confirmMsg.message_id, 5000);

          // Обновляем шаг 11 чтобы показать новый счетчик на кнопке
          await askStep11(chatId, userId);
        } else {
          const errMsg = await bot.sendMessage(chatId, '❌ Пожалуйста, отправь фотографию или нажми кнопку "Завершить"');
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        }
        break;
    }

    return;
  }
});

// ==================== ОБРАБОТКА ОШИБОК ====================

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});

console.log('🤖 Бот запущен успешно!');