require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const CHANNEL_ID = process.env.CHANNEL_ID; // например: @golos_stroyki

// Инициализация
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Тест соединения
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

// Хранилище состояний пользователей
const userStates = {};

// Хранилище состояний поиска
const searchStates = {};

// Хранилище состояний жалоб
const complaintStates = {};

// Хранилище ID сообщений для редактирования (живые сообщения)
const liveMessages = {};

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
    parse_mode: 'Markdown',
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
function validateProductsServices(text) {
  if (!text || text.trim().length < 10) {
    return { valid: false, message: '❌ Опишите что вы поставляете/сдаёте в аренду (минимум 10 символов).' };
  }
  if (text.length > 400) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 400 символов.' };
  }
  return { valid: true };
}

function validateGeography(text) {
  if (!text || text.trim().length < 3) {
    return { valid: false, message: '❌ Укажите географию работы.' };
  }
  if (text.length > 300) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 300 символов.' };
  }
  return { valid: true };
}

function validateMinOrderConditions(text) {
  if (!text || text.trim().length < 5) {
    return { valid: false, message: '❌ Укажите минимальный заказ и условия (минимум 5 символов).' };
  }
  if (text.length > 300) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 300 символов.' };
  }
  return { valid: true };
}

function validateCompanyInfo(text) {
  if (!text || text.trim().length < 3) {
    return { valid: false, message: '❌ Укажите информацию о компании.' };
  }
  if (text.length > 400) {
    return { valid: false, message: '❌ Описание слишком длинное. Максимум 400 символов.' };
  }
  return { valid: true };
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

// Форматирование текста для Telegram (Markdown)
function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Форматирование текущей анкеты для отображения
function formatCurrentFormData(userData, currentStep) {
  let formText = '📋 *Твоя анкета:*\n\n';

  if (userData.workFormat) {
    formText += `1️⃣ Формат работы: ${userData.workFormat}\n`;
  }
  if (userData.city) {
    formText += `2️⃣ Город: ${userData.city}\n`;
  }
  if (userData.specialization) {
    formText += `3️⃣ Специализация: ${userData.specialization}\n`;
  }
  if (userData.experience) {
    formText += `4️⃣ Опыт: ${userData.experience}\n`;
  }
  if (userData.objectsWorked) {
    formText += `5️⃣ Объекты: ${userData.objectsWorked}\n`;
  }
  if (userData.workVolume) {
    formText += `6️⃣ Объём работ: ${userData.workVolume}\n`;
  }
  if (userData.documentsForm) {
    formText += `7️⃣ Документы: ${userData.documentsForm}\n`;
  }
  if (userData.paymentConditions) {
    formText += `8️⃣ Условия оплаты: ${userData.paymentConditions}\n`;
  }
  if (userData.contact) {
    formText += `9️⃣ Контакт: ${userData.contact}\n`;
  }
  if (currentStep >= 10) {
    if (userData.photoUrl) {
      formText += `🔟 Фото: добавлено\n`;
    } else if (userData.photoUrl === null) {
      formText += `🔟 Фото: нет фото\n`;
    }
  }

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  return formText;
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
          work_format: data.workFormat,
          city: data.city,
          specialization: data.specialization,
          experience: data.experience,
          objects_worked: data.objectsWorked,
          work_volume: data.workVolume,
          documents_form: data.documentsForm,
          payment_conditions: data.paymentConditions,
          contact: data.contact,
          photo_url: data.photoUrl,
          telegram_tag: data.telegramTag,
          status: 'pending', // на модерации
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
          volume_timeline: data.volumeTimeline,
          executor_requirements: data.executorRequirements,
          payment_conditions: data.paymentConditions,
          cooperation_format: data.cooperationFormat,
          contact: data.contact,
          telegram_tag: data.telegramTag,
          status: 'pending',
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
async function saveSupplierToDatabase(data) {
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
      .from('suppliers')
      .insert([
        {
          telegram_id: data.userId,
          username: data.username,
          supplier_type: data.supplierType,
          products_services: data.productsServices,
          geography: data.geography,
          target_audience: data.targetAudience,
          min_order_conditions: data.minOrderConditions,
          contact: data.contact,
          company_info: data.companyInfo,
          telegram_tag: data.telegramTag,
          status: 'pending',
          created_at: new Date().toISOString()
        }
      ])
      .select();

    if (error) {
      console.error('❌ Ошибка Supabase при сохранении поставщика:', error.message, error.details, error.hint);
      throw error;
    }

    console.log('✅ Поставщик успешно сохранён в БД:', result);
    return { success: true, data: result };
  } catch (error) {
    console.error('❌ Ошибка сохранения поставщика в БД:', {
      message: error.message || 'Неизвестная ошибка',
      details: error.details || '',
      hint: error.hint || '',
      code: error.code || ''
    });
    return { success: false, error };
  }
}

// ==================== КЛАВИАТУРЫ ====================

const communityKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '💬 Сообщество Голос Стройки' }]
    ],
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

// ==================== КОМАНДЫ ====================

// Команда /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || 'без username';
  
  console.log(`Пользователь ${username} (${userId}) запустил бота`);
  
  // Проверяем подписку
  const isSubscribed = await checkSubscription(userId);
  
  if (!isSubscribed) {
    const welcomeText = `👋 *Привет, ${escapeMarkdown(msg.from.first_name || 'друг')}\\!*

📋 Ты в *Каталоге подрядчиков* проекта *Голос Стройки*\\.

Здесь ты можешь:
🔹 найти надёжного подрядчика
🔹 посмотреть реальные профили
🔹 получить контакт
🔹 или добавить себя в каталог \\(если ты мастер/компания\\)

⚠️ *Перед использованием бота нужно быть подписанным на сообщество* ["Голос Стройки"](https://t.me/${CHANNEL_ID.replace('@', '')})`;

    await bot.sendMessage(chatId, welcomeText, {
      parse_mode: 'MarkdownV2',
      ...checkSubscriptionKeyboard,
      disable_web_page_preview: true
    });
    return;
  }
  
  // Если подписан - показываем главное меню
  await showMainMenu(chatId);
});

// Показать главное меню
async function showMainMenu(chatId) {
  const menuText = `Привет 👋
Это бот базы сообщества «Голос Стройки».
За 2–3 минуты добавим тебя в общую базу, чтобы:
— быстрее находить работу и объекты;
— находить подрядчиков и рабочих;
— получать запросы из сообщества.

👤 Кого будем добавлять в базу?`;

  // Сначала устанавливаем обычную клавиатуру
  const tempMessage = await bot.sendMessage(chatId, '💬 Используй кнопку ниже для перехода в сообщество', communityKeyboard);

  // Удаляем это сообщение через 3 секунды
  setTimeout(async () => {
    await safeDeleteMessage(chatId, tempMessage.message_id);
  }, 8000);

  // Затем отправляем сообщение с инлайн-кнопками и сохраняем ID
  const menuMessage = await bot.sendMessage(chatId, menuText, {
    reply_markup: {
      inline_keyboard: [
        // [{ text: '🔍 Найти подрядчика', callback_data: 'search_contractor' }],
        [{ text: '🧱 Я специалист / бригада / компания', callback_data: 'add_contractor' }],
        [{ text: '🏗 У меня объект / заказ', callback_data: 'add_order' }],
        [{ text: '🚚 Я поставщик материалов / техники', callback_data: 'add_supplier' }],
        [{ text: '⭕️ Отправить жалобу', callback_data: 'send_complaint' }],
        [{ text: '❓ FAQ / Помощь', callback_data: 'faq_help' }]
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
  
  // Проверка подписки
  if (data === 'check_subscription') {
    const isSubscribed = await checkSubscription(userId);

    if (isSubscribed) {
      await safeDeleteMessage(chatId, query.message.message_id);
      await showMainMenu(chatId);
      await bot.answerCallbackQuery(query.id, { text: '✅ Отлично! Подписка подтверждена' });
    } else {
      await bot.answerCallbackQuery(query.id, {
        text: '❌ Подписка не найдена. Пожалуйста, подпишись на канал.',
        show_alert: true
      });
    }
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

  // Начало заполнения формы поставщика
  if (data === 'start_supplier_form') {
    await safeDeleteMessage(chatId, query.message.message_id);
    await startSupplierFormProcess(chatId, userId, query.from.username);
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

  // Пропуск фото на шаге 10
  if (data === 'skip_photo') {
    await bot.answerCallbackQuery(query.id);

    if (userStates[userId] && userStates[userId].step === 10) {
      // Устанавливаем photoUrl в null
      userStates[userId].data.photoUrl = null;

      const skipMsg = await bot.sendMessage(chatId, '⏭ Шаг пропущен. Фото не добавлено.');
      deleteMessageAfterDelay(chatId, skipMsg.message_id);

      // Переходим к финальному шагу
      userStates[userId].step = 11;
      await askStep11(chatId, userId);
    }
    return;
  }

  // Подтверждение анкеты на шаге 11 (Contractor)
  if (data === 'confirm_form') {
    await bot.answerCallbackQuery(query.id);

    if (userStates[userId] && userStates[userId].formType === 'contractor' && userStates[userId].step === 11) {
      // Завершаем анкету и отправляем в БД
      await finishForm(chatId, userId, query.from.username);
    }
    return;
  }

  // Подтверждение заявки на шаге 10 (Order)
  if (data === 'confirm_order_form') {
    await bot.answerCallbackQuery(query.id);

    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 10) {
      // Завершаем заявку и отправляем в БД
      await finishOrderForm(chatId, userId);
    }
    return;
  }

  // Подтверждение анкеты на шаге 8 (Supplier)
  if (data === 'confirm_supplier_form') {
    await bot.answerCallbackQuery(query.id);

    if (userStates[userId] && userStates[userId].formType === 'supplier' && userStates[userId].step === 8) {
      // Завершаем анкету и отправляем в БД
      await finishSupplierForm(chatId, userId);
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

  // Обработка кнопок выбора города (шаг 2)
  if (data.startsWith('city_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].step === 2) {
      let city = '';
      if (data === 'city_moscow') city = 'Москва';
      else if (data === 'city_spb') city = 'Санкт-Петербург';
      else if (data === 'city_any') city = 'Готов работать в любом городе';

      userStates[userId].data.city = city;
      userStates[userId].step = 3;
      await askStep3(chatId, userId);
    }
    return;
  }

  // Обработка кнопок выбора опыта (шаг 4)
  if (data.startsWith('exp_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].step === 4) {
      let experience = '';
      if (data === 'exp_less1') experience = 'Менее 1 года';
      else if (data === 'exp_1_3') experience = '1-3 года';
      else if (data === 'exp_3_5') experience = '3-5 лет';
      else if (data === 'exp_5_10') experience = '5-10 лет';
      else if (data === 'exp_more10') experience = 'Более 10 лет';

      userStates[userId].data.experience = experience;
      userStates[userId].step = 5;
      await askStep5(chatId, userId);
    }
    return;
  }

  // Обработка кнопок выбора документов (шаг 7)
  if (data.startsWith('doc_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].step === 7) {
      let documentsForm = '';
      if (data === 'doc_ip') documentsForm = 'ИП';
      else if (data === 'doc_samozanyaty') documentsForm = 'Самозанятый';
      else if (data === 'doc_ooo') documentsForm = 'ООО';
      else if (data === 'doc_contract') documentsForm = 'По договору';
      else if (data === 'doc_none') documentsForm = 'Без оформления';

      userStates[userId].data.documentsForm = documentsForm;
      userStates[userId].step = 8;
      await askStep8(chatId, userId);
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

  // Обработка кнопок города (Order Step 2)
  if (data.startsWith('ord_city_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 2) {
      let city = '';
      if (data === 'ord_city_moscow') city = 'Москва';
      else if (data === 'ord_city_spb') city = 'Санкт-Петербург';

      userStates[userId].data.cityLocation = city;
      userStates[userId].step = 3;

      await askOrderStep3(chatId, userId);
    }
    return;
  }

  // Обработка кнопок типа объекта (Order Step 3)
  if (data.startsWith('ord_obj_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 3) {
      let objectType = '';
      if (data === 'ord_obj_apartment') objectType = 'Квартира';
      else if (data === 'ord_obj_house') objectType = 'Дом';
      else if (data === 'ord_obj_residential') objectType = 'ЖК';
      else if (data === 'ord_obj_commercial') objectType = 'Коммерция';
      else if (data === 'ord_obj_industrial') objectType = 'Промышленный';
      else if (data === 'ord_obj_roads') objectType = 'Дороги';

      userStates[userId].data.objectType = objectType;
      userStates[userId].step = 4;

      await askOrderStep4(chatId, userId);
    }
    return;
  }

  // Обработка кнопок формата сотрудничества (Order Step 8)
  if (data.startsWith('ord_coop_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'order' && userStates[userId].step === 8) {
      let cooperationFormat = '';
      if (data === 'ord_coop_general') cooperationFormat = 'Генподряд';
      else if (data === 'ord_coop_sub') cooperationFormat = 'Субподряд';
      else if (data === 'ord_coop_shifts') cooperationFormat = 'По сменам';
      else if (data === 'ord_coop_onetime') cooperationFormat = 'Разовый проект';
      else if (data === 'ord_coop_longterm') cooperationFormat = 'Долгосрочное сотрудничество';

      userStates[userId].data.cooperationFormat = cooperationFormat;
      userStates[userId].step = 9;

      await askOrderStep9(chatId, userId);
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

  // ========== CALLBACK HANDLERS ДЛЯ ВЕТКИ SUPPLIER ==========

  // Обработка кнопок типа поставщика (Supplier Step 1)
  if (data.startsWith('sup_type_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'supplier' && userStates[userId].step === 1) {
      let supplierType = '';
      if (data === 'sup_type_manufacturer') supplierType = 'Производитель';
      else if (data === 'sup_type_supplier') supplierType = 'Поставщик';
      else if (data === 'sup_type_rent') supplierType = 'Аренда техники / механизмов';

      userStates[userId].data.supplierType = supplierType;
      userStates[userId].step = 2;

      await askSupplierStep2(chatId, userId);
    }
    return;
  }

  // Обработка кнопок города (Supplier Step 3)
  if (data.startsWith('sup_city_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'supplier' && userStates[userId].step === 3) {
      let city = '';
      if (data === 'sup_city_moscow') city = 'Москва';
      else if (data === 'sup_city_spb') city = 'Санкт-Петербург';

      userStates[userId].data.geography = city;
      userStates[userId].step = 4;

      await askSupplierStep4(chatId, userId);
    }
    return;
  }

  // Обработка кнопок целевой аудитории (Supplier Step 4)
  if (data.startsWith('sup_aud_')) {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'supplier' && userStates[userId].step === 4) {
      let audience = '';
      if (data === 'sup_aud_private') audience = 'Частники';
      else if (data === 'sup_aud_contractors') audience = 'Подрядчики';
      else if (data === 'sup_aud_developers') audience = 'Застройщики';
      else if (data === 'sup_aud_all') audience = 'Не важно (все)';

      userStates[userId].data.targetAudience = audience;
      userStates[userId].step = 5;

      await askSupplierStep5(chatId, userId);
    }
    return;
  }


  // Обработка кнопки "Назад" для Supplier
  if (data === 'supplier_back') {
    await bot.answerCallbackQuery(query.id);
    if (userStates[userId] && userStates[userId].formType === 'supplier') {
      const currentStep = userStates[userId].step;
      if (currentStep > 1) {
        userStates[userId].step = currentStep - 1;
        const step = currentStep - 1;

        if (step === 1) await askSupplierStep1(chatId, userId);
        else if (step === 2) await askSupplierStep2(chatId, userId);
        else if (step === 3) await askSupplierStep3(chatId, userId);
        else if (step === 4) await askSupplierStep4(chatId, userId);
        else if (step === 5) await askSupplierStep5(chatId, userId);
        else if (step === 6) await askSupplierStep6(chatId, userId);
        else if (step === 7) await askSupplierStep7(chatId, userId);
        else if (step === 8) await askSupplierStep8(chatId, userId);
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
    await bot.sendMessage(chatId, '📞 *Поддержка*\n\nНапиши свой вопрос, и мы постараемся помочь.', {
      parse_mode: 'Markdown',
      ...communityKeyboard
    });
    return;
  }

  // Добавить себя как специалист/бригада/компания
  if (data === 'add_contractor') {
    // Удаляем меню
    if (liveMessages[chatId] && liveMessages[chatId].menuMessageId) {
      try {
        await safeDeleteMessage(chatId, liveMessages[chatId].menuMessageId);
      } catch (error) {
        console.log('Меню уже удалено');
      }
    }
    await bot.answerCallbackQuery(query.id);
    const confirmText = `🔧 *Отлично\\!*

Сейчас мы создадим твою карточку подрядчика\\.
Процесс займёт 1–2 минуты\\.

Начнём?`;

    await bot.sendMessage(chatId, confirmText, {
      parse_mode: 'MarkdownV2',
      ...confirmStartFormKeyboard
    });
    return;
  }

  // Добавить объект/заказ
  if (data === 'add_order') {
    // Удаляем меню
    if (liveMessages[chatId] && liveMessages[chatId].menuMessageId) {
      try {
        await safeDeleteMessage(chatId, liveMessages[chatId].menuMessageId);
      } catch (error) {
        console.log('Меню уже удалено');
      }
    }
    await bot.answerCallbackQuery(query.id);
    const confirmText = `🏗 *Добавим в базу твой объект / заказ*

Постарайся отвечать конкретно — это экономит время и тебе\\, и исполнителям\\.

Начнём?`;

    await bot.sendMessage(chatId, confirmText, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Да, начать', callback_data: 'start_order_form' }],
          [{ text: '❌ Отмена', callback_data: 'cancel_form' }]
        ]
      }
    });
    return;
  }

  // Добавить поставщика
  if (data === 'add_supplier') {
    // Удаляем меню
    if (liveMessages[chatId] && liveMessages[chatId].menuMessageId) {
      try {
        await safeDeleteMessage(chatId, liveMessages[chatId].menuMessageId);
      } catch (error) {
        console.log('Меню уже удалено');
      }
    }
    await bot.answerCallbackQuery(query.id);
    const confirmText = `🚚 *Добавим тебя в базу поставщиков и аренды техники*

Расскажи о своих услугах\\.

Начнём?`;

    await bot.sendMessage(chatId, confirmText, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Да, начать', callback_data: 'start_supplier_form' }],
          [{ text: '❌ Отмена', callback_data: 'cancel_form' }]
        ]
      }
    });
    return;
  }

  if (data === 'send_complaint') {
    // Удаляем меню
    if (liveMessages[chatId] && liveMessages[chatId].menuMessageId) {
      try {
        await safeDeleteMessage(chatId, liveMessages[chatId].menuMessageId);
      } catch (error) {
        console.log('Меню уже удалено');
      }
    }
    await bot.answerCallbackQuery(query.id);

    // Инициализируем состояние жалобы
    complaintStates[userId] = { active: true };

    const complaintMsg = await bot.sendMessage(chatId, '📝 Напиши свою жалобу, и мы её рассмотрим.\n\n_Минимум 10 символов_', {
      parse_mode: 'Markdown',
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

    const faqText = `❓ *FAQ / Помощь*

📚 Выбери интересующий раздел:`;

    await bot.sendMessage(chatId, faqText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔹 Как работает каталог?', callback_data: 'faq_how_works' }],
          [{ text: '🔹 Как добавить себя в каталог?', callback_data: 'faq_how_add' }],
          [{ text: '🔹 Сколько стоит размещение?', callback_data: 'faq_price' }],
          [{ text: '🔹 Как пожаловаться на подрядчика?', callback_data: 'faq_complaint' }],
          [{ text: '◀️ Назад в меню', callback_data: 'back_to_main_menu' }]
        ]
      }
    });
    return;
  }

  // Обработка FAQ кнопок
  if (data === 'faq_how_works') {
    await bot.answerCallbackQuery(query.id);
    // Удаляем предыдущее сообщение с меню FAQ
    await safeDeleteMessage(chatId, query.message.message_id);

    const text = `📖 *Как работает каталог?*

Каталог "Голос Стройки" — это база проверенных подрядчиков.

✅ Все анкеты проходят модерацию
✅ Клиенты видят портфолио и отзывы
✅ Прямой контакт с мастером
✅ Поиск по городу и специализации

Это удобный способ найти надёжного исполнителя для твоего проекта!`;

    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❓ Другой вопрос', callback_data: 'faq_help' }],
          [{ text: '◀️ Назад в меню', callback_data: 'back_to_main_menu' }]
        ]
      }
    });
    return;
  }

  if (data === 'faq_how_add') {
    await bot.answerCallbackQuery(query.id);
    // Удаляем предыдущее сообщение с меню FAQ
    await safeDeleteMessage(chatId, query.message.message_id);

    const text = `➕ *Как добавить себя в каталог?*

Это очень просто:

1️⃣ Нажми кнопку "➕ Добавить себя в каталог" в главном меню
2️⃣ Заполни короткую анкету (8 шагов, 2-3 минуты)
3️⃣ Отправь анкету на модерацию
4️⃣ Получи уведомление об одобрении

После модерации твоя карточка появится в каталоге, и клиенты смогут с тобой связаться!`;

    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❓ Другой вопрос', callback_data: 'faq_help' }],
          [{ text: '◀️ Назад в меню', callback_data: 'back_to_main_menu' }]
        ]
      }
    });
    return;
  }

  if (data === 'faq_price') {
    await bot.answerCallbackQuery(query.id);
    // Удаляем предыдущее сообщение с меню FAQ
    await safeDeleteMessage(chatId, query.message.message_id);

    const text = `💰 *Сколько стоит размещение?*

Размещение в каталоге "Голос Стройки" — *БЕСПЛАТНО*! 🎉

✅ Бесплатное создание карточки
✅ Бесплатная модерация
✅ Бесплатное размещение в каталоге
✅ Неограниченное время размещения

Мы хотим помочь мастерам найти клиентов, а клиентам — надёжных подрядчиков.`;

    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❓ Другой вопрос', callback_data: 'faq_help' }],
          [{ text: '◀️ Назад в меню', callback_data: 'back_to_main_menu' }]
        ]
      }
    });
    return;
  }

  if (data === 'faq_complaint') {
    await bot.answerCallbackQuery(query.id);
    // Удаляем предыдущее сообщение с меню FAQ
    await safeDeleteMessage(chatId, query.message.message_id);

    const text = `⚠️ *Как пожаловаться на подрядчика?*

Если у тебя возникла проблема с подрядчиком:

1️⃣ Нажми кнопку "⭕️ Отправить жалобу" в главном меню
2️⃣ Опиши ситуацию подробно
3️⃣ Укажи имя подрядчика и его контакт
4️⃣ По возможности приложи доказательства

Мы рассмотрим жалобу в течение 24 часов и примем меры: от предупреждения до удаления из каталога.`;

    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❓ Другой вопрос', callback_data: 'faq_help' }],
          [{ text: '◀️ Назад в меню', callback_data: 'back_to_main_menu' }]
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

  const text = `🏙 *Поиск подрядчика*

Напиши город, в котором ищешь подрядчика:

_Например: Москва, Санкт-Петербург, Казань_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        [{ text: '❌ Отменить поиск' }]
      ],
      resize_keyboard: true
    }
  });
}

async function askWorkType(chatId, userId) {
  const text = `🔧 *Какой тип работ нужен?*

Опиши, какие работы нужно выполнить:

_Например: отделка квартиры, укладка плитки, малярные работы_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
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
        `😔 К сожалению, по запросу *"${searchData.workType}"* в городе *"${searchData.city}"* подрядчики не найдены.\n\nПопробуй изменить параметры поиска.`,
        {
          parse_mode: 'Markdown',
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
    ? `🎯 По вашему запросу найдено *${totalCount}* ${totalCount === 1 ? 'специалист' : totalCount < 5 ? 'специалиста' : 'специалистов'}.\n\nВот ${contractors.length === 1 ? 'первый' : `первые ${contractors.length}`}:`
    : `📄 Показываю еще ${contractors.length} ${contractors.length === 1 ? 'специалиста' : 'специалистов'}:`;

  await bot.sendMessage(chatId, headerText, { parse_mode: 'Markdown' });

  // Отправляем карточки подрядчиков
  for (const contractor of contractors) {
    // Отправляем фото профиля, если оно есть
    if (contractor.photo_url) {
      try {
        await bot.sendPhoto(chatId, contractor.photo_url, {
          caption: formatContractorCard(contractor),
          parse_mode: 'Markdown'
        });
      } catch (error) {
        console.error('Ошибка отправки фото:', error);
        // Если фото не удалось отправить, отправляем только текст
        const card = formatContractorCard(contractor);
        await bot.sendMessage(chatId, card, { parse_mode: 'Markdown' });
      }
    } else {
      // Если фото нет, отправляем только текстовую карточку
      const card = formatContractorCard(contractor);
      await bot.sendMessage(chatId, card, { parse_mode: 'Markdown' });
    }
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

function formatContractorCard(contractor) {
  return `━━━━━━━━━━━━━━━
🔨 *Специализация:* ${contractor.specialization}
📍 *Город:* ${contractor.city}
👤 *Имя:* ${contractor.name}
⭐️ *Опыт:* ${contractor.experience}
💬 _"${contractor.description}"_
💵 *Цена:* ${contractor.price}

📞 *Контакт:* ${contractor.contact}
📸 *Портфолио:* ${contractor.portfolio_link}`;
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

// ==================== ВЕТКА: ПОСТАВЩИК ====================

async function startSupplierFormProcess(chatId, userId, username) {
  // Инициализируем состояние для ветки suppliers
  userStates[userId] = {
    formType: 'supplier',
    step: 1,
    chatId,
    username: username || 'неизвестен',
    data: {}
  };

  await askSupplierStep1(chatId, userId);
}

// Шаг 1 - Формат работы (специалист/бригада/компания)
async function askStep1(chatId, userId) {
  const text = `📝 *Шаг 1 из 11* — Формат работы

Вы работаете как:

_Выбери из кнопок ниже или напиши свой вариант_`;

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
    parse_mode: 'Markdown',
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

// Шаг 2 - Город/регион
async function askStep2(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 2);

  const text = `${formData}📍 *Шаг 2 из 11* — Город/регион

В каком городе работаешь?

_Выбери из кнопок или напиши свой город_`;

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
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Москва', callback_data: 'city_moscow' }],
        [{ text: 'Санкт-Петербург', callback_data: 'city_spb' }],
        [{ text: 'Готов работать в любом городе', callback_data: 'city_any' }],
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 3 - Специализация (только свободный ввод)
async function askStep3(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 3);

  const text = `${formData}🔧 *Шаг 3 из 11* — Специализация

Кратко напиши чем занимаешься, какие услуги оказываешь?

_Например: "Отделка квартир, малярка, плитка, электрика"_`;

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
    parse_mode: 'Markdown',
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

// Шаг 4 - Опыт работы (с кнопками + свободный ввод)
async function askStep4(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 4);

  const text = `${formData}⏱ *Шаг 4 из 11* — Опыт работы в строительстве

Сколько лет опыта?

_Выбери из кнопок или напиши свой вариант_`;

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
    parse_mode: 'Markdown',
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

// Шаг 5 - На каких объектах работали (только свободный ввод)
async function askStep5(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 5);

  const text = `${formData}🏗 *Шаг 5 из 11* — На каких объектах работали

Опиши какие объекты выполнял:

_Например: "Квартиры, офисы, коттеджи. Работал на объектах от 50 до 300 кв.м."_`;

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
    parse_mode: 'Markdown',
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

// Шаг 6 - Объём работ (только свободный ввод)
async function askStep6(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 6);

  const text = `${formData}📊 *Шаг 6 из 11* — Объём работ

Какой объём работ можешь выполнить? Сколько человек в команде?

_Например: "Работаю один, могу взять объект до 50 кв.м." или "Бригада 5 человек, можем выполнить квартиру под ключ за месяц"_`;

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
    parse_mode: 'Markdown',
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

// Шаг 7 - Документы/форма работы (с кнопками + свободный ввод)
async function askStep7(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 7);

  const text = `${formData}📄 *Шаг 7 из 11* — Документы / Форма работы

Как работаешь?

_Выбери из кнопок или напиши свой вариант_`;

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
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'ИП', callback_data: 'doc_ip' }, { text: 'Самозанятый', callback_data: 'doc_samozanyaty' }],
        [{ text: 'ООО', callback_data: 'doc_ooo' }, { text: 'По договору', callback_data: 'doc_contract' }],
        [{ text: 'Без оформления', callback_data: 'doc_none' }],
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 8 - Условия оплаты (только свободный ввод)
async function askStep8(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 8);

  const text = `${formData}💰 *Шаг 8 из 11* — Условия оплаты

Напиши условия оплаты и стоимость:

_Например: "от 2000 ₽/м², оплата 50% аванс, 50% после завершения" или "Договорная, обсуждается индивидуально"_`;

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
    parse_mode: 'Markdown',
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

// Шаг 9 - Контакты (номер телефона)
async function askStep9(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 9);

  const text = `${formData}📞 *Шаг 9 из 11* — Контакты

Оставь номер телефона для клиентов:

_Можешь отправить свой контакт кнопкой ниже или написать вручную 👇_`;

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
    parse_mode: 'Markdown',
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

// Шаг 10 - Фото
async function askStep10(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 10);

  const text = `${formData}📷 *Шаг 10 из 11* — Фотография профиля

Добавь свою фотографию, чтобы привлечь больше работодателей!

Анкеты с фото получают *в 3 раза больше откликов*.

Отправь фото или нажми "Пропустить" 👇`;

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
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⏭ Пропустить', callback_data: 'skip_photo' }],
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ],
      remove_keyboard: true
    }
  });

  // Сохраняем ID нового сообщения
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 11 - Финальное согласование (проверка данных)
async function askStep11(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 11);

  const text = `${formData}✅ *Шаг 11 из 11* — Финальное согласование

*Проверьте правильность ввода данных.*

Если всё верно — нажми *"Подтвердить"*
Если нужно исправить — нажми *"Назад"*`;

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
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Подтвердить', callback_data: 'confirm_form' }],
        [{ text: '◀️ Назад', callback_data: 'form_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  // Сохраняем ID нового сообщения
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Завершение анкеты
async function finishForm(chatId, userId, telegramUsername) {
  const userData = userStates[userId];

  // Сохраняем в базу данных
  const result = await saveContractorToDatabase({
    userId,
    username: userData.username,
    workFormat: userData.data.workFormat,
    city: userData.data.city,
    specialization: userData.data.specialization,
    experience: userData.data.experience,
    objectsWorked: userData.data.objectsWorked,
    workVolume: userData.data.workVolume,
    documentsForm: userData.data.documentsForm,
    paymentConditions: userData.data.paymentConditions,
    contact: userData.data.contact,
    photoUrl: userData.data.photoUrl,
    telegramTag: telegramUsername ? `@${telegramUsername}` : null
  });

  if (result.success) {
    const successText = `🎉 *Отлично\\!*

Твоя анкета отправлена на модерацию\\.

Когда карточка будет утверждена — мы пришлём уведомление\\.

📋 *Твои данные:*
💼 Формат работы: ${escapeMarkdown(userData.data.workFormat)}
📍 Город: ${escapeMarkdown(userData.data.city)}
🔧 Специализация: ${escapeMarkdown(userData.data.specialization)}
⏱ Опыт: ${escapeMarkdown(userData.data.experience)}
🏗 Объекты: ${escapeMarkdown(userData.data.objectsWorked)}
📊 Объём работ: ${escapeMarkdown(userData.data.workVolume)}
📄 Документы: ${escapeMarkdown(userData.data.documentsForm)}
💰 Условия оплаты: ${escapeMarkdown(userData.data.paymentConditions)}
📞 Контакт: ${escapeMarkdown(userData.data.contact)}
📷 Фото: ${userData.data.photoUrl ? 'добавлено' : 'нет фото'}`;

    await bot.sendMessage(chatId, successText, {
      parse_mode: 'MarkdownV2',
      ...mainMenuKeyboard
    });
  } else {
    await bot.sendMessage(chatId, '❌ Произошла ошибка при сохранении данных. Попробуй позже.', mainMenuKeyboard);
  }

  // Очищаем состояние
  delete userStates[userId];

  // Показываем главное меню
  await showMainMenu(chatId);
}

// Завершение анкеты Order
async function finishOrderForm(chatId, userId) {
  const userData = userStates[userId];

  // Сохраняем в базу данных
  const result = await saveOrderToDatabase({
    userId,
    username: userData.username,
    requestType: userData.data.requestType,
    cityLocation: userData.data.cityLocation,
    objectType: userData.data.objectType,
    workType: userData.data.workType,
    volumeTimeline: userData.data.volumeTimeline,
    executorRequirements: userData.data.executorRequirements,
    paymentConditions: userData.data.paymentConditions,
    cooperationFormat: userData.data.cooperationFormat,
    contact: userData.data.contact,
    telegramTag: userData.data.telegramTag
  });

  if (result.success) {
    const successText = `🎉 *Отлично\\!*

Твоя заявка отправлена на модерацию\\.

Когда заявка будет утверждена — мы пришлём уведомление\\.

📋 *Твоя заявка:*
👥 Кого ищешь: ${escapeMarkdown(userData.data.requestType)}
📍 Город: ${escapeMarkdown(userData.data.cityLocation)}
🏗 Тип объекта: ${escapeMarkdown(userData.data.objectType)}
🔨 Работы: ${escapeMarkdown(userData.data.workType)}
📊 Объём и сроки: ${escapeMarkdown(userData.data.volumeTimeline)}
👤 Требования: ${escapeMarkdown(userData.data.executorRequirements)}
💰 Оплата: ${escapeMarkdown(userData.data.paymentConditions)}
🤝 Формат: ${escapeMarkdown(userData.data.cooperationFormat)}
📞 Контакт: ${escapeMarkdown(userData.data.contact)}`;

    await bot.sendMessage(chatId, successText, {
      parse_mode: 'MarkdownV2',
      ...mainMenuKeyboard
    });
  } else {
    await bot.sendMessage(chatId, '❌ Произошла ошибка при сохранении данных. Попробуй позже.', mainMenuKeyboard);
  }

  // Очищаем состояние
  delete userStates[userId];

  // Показываем главное меню
  await showMainMenu(chatId);
}

// Завершение анкеты Supplier
async function finishSupplierForm(chatId, userId) {
  const userData = userStates[userId];

  // Сохраняем в базу данных
  const result = await saveSupplierToDatabase({
    userId,
    username: userData.username,
    supplierType: userData.data.supplierType,
    productsServices: userData.data.productsServices,
    geography: userData.data.geography,
    targetAudience: userData.data.targetAudience,
    minOrderConditions: userData.data.minOrderConditions,
    contact: userData.data.contact,
    companyInfo: userData.data.companyInfo,
    telegramTag: userData.data.telegramTag
  });

  if (result.success) {
    const successText = `🎉 *Отлично\\!*

Твоя анкета отправлена на модерацию\\.

Когда анкета будет утверждена — мы пришлём уведомление\\.

📋 *Твоя анкета:*
🏢 Формат: ${escapeMarkdown(userData.data.supplierType)}
📦 Что поставляете: ${escapeMarkdown(userData.data.productsServices)}
🌍 География: ${escapeMarkdown(userData.data.geography)}
👥 Для кого: ${escapeMarkdown(userData.data.targetAudience)}
📋 Условия: ${escapeMarkdown(userData.data.minOrderConditions)}
📞 Контакт: ${escapeMarkdown(userData.data.contact)}
🏢 О компании: ${escapeMarkdown(userData.data.companyInfo)}`;

    await bot.sendMessage(chatId, successText, {
      parse_mode: 'MarkdownV2',
      ...mainMenuKeyboard
    });
  } else {
    await bot.sendMessage(chatId, '❌ Произошла ошибка при сохранении данных. Попробуй позже.', mainMenuKeyboard);
  }

  // Очищаем состояние
  delete userStates[userId];

  // Показываем главное меню
  await showMainMenu(chatId);
}

// ==================== ШАГИ ДЛЯ ВЕТКИ ORDER (ОБЪЕКТ/ЗАКАЗ) ====================

// Шаг 1 Order - Тип запроса
async function askOrderStep1(chatId, userId) {
  const text = `📝 *Шаг 1 из 10* — Кого ищешь?

_Выбери из кнопок ниже_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Бригаду / подрядчика', callback_data: 'ord_req_brigade' }],
        [{ text: 'Рабочих по сменам', callback_data: 'ord_req_workers' }],
        [{ text: 'Инженерный состав', callback_data: 'ord_req_engineers' }],
        [{ text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 2 Order - Город и локация объекта
async function askOrderStep2(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя заявка:*\n\n';

  if (userData.requestType) formText += `1️⃣ Кого ищешь: ${userData.requestType}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}📍 *Шаг 2 из 10* — Город и локация объекта

_Выбери город из кнопок или напиши свой вариант_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
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

// Шаг 3 Order - Тип объекта
async function askOrderStep3(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя заявка:*\n\n';

  if (userData.requestType) formText += `1️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `2️⃣ Город: ${userData.cityLocation}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}🏗 *Шаг 3 из 10* — Тип объекта

_Выбери тип из кнопок или напиши свой вариант_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Квартира', callback_data: 'ord_obj_apartment' }],
        [{ text: 'Дом', callback_data: 'ord_obj_house' }],
        [{ text: 'ЖК', callback_data: 'ord_obj_residential' }],
        [{ text: 'Коммерция', callback_data: 'ord_obj_commercial' }],
        [{ text: 'Промышленный', callback_data: 'ord_obj_industrial' }],
        [{ text: 'Дороги', callback_data: 'ord_obj_roads' }],
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 4 Order - Какие работы нужны
async function askOrderStep4(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя заявка:*\n\n';

  if (userData.requestType) formText += `1️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `2️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `3️⃣ Тип объекта: ${userData.objectType}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}🔨 *Шаг 4 из 10* — Какие работы нужны?

_Опиши какие работы требуются на объекте_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 5 Order - Объём и сроки
async function askOrderStep5(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя заявка:*\n\n';

  if (userData.requestType) formText += `1️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `2️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `3️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `4️⃣ Работы: ${userData.workType}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}📊 *Шаг 5 из 10* — Объём и сроки

_Укажи объём работ и желаемые сроки выполнения_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 6 Order - Требования к исполнителю
async function askOrderStep6(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя заявка:*\n\n';

  if (userData.requestType) formText += `1️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `2️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `3️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `4️⃣ Работы: ${userData.workType}\n`;
  if (userData.volumeTimeline) formText += `5️⃣ Объём и сроки: ${userData.volumeTimeline}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}👤 *Шаг 6 из 10* — Требования к исполнителю

_Опиши требования к исполнителю (опыт, квалификация и т.д.)_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 7 Order - Условия оплаты
async function askOrderStep7(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя заявка:*\n\n';

  if (userData.requestType) formText += `1️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `2️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `3️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `4️⃣ Работы: ${userData.workType}\n`;
  if (userData.volumeTimeline) formText += `5️⃣ Объём и сроки: ${userData.volumeTimeline}\n`;
  if (userData.executorRequirements) formText += `6️⃣ Требования: ${userData.executorRequirements}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}💰 *Шаг 7 из 10* — Условия оплаты

_Укажи условия оплаты для исполнителя_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'order_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 8 Order - Формат сотрудничества
async function askOrderStep8(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя заявка:*\n\n';

  if (userData.requestType) formText += `1️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `2️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `3️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `4️⃣ Работы: ${userData.workType}\n`;
  if (userData.volumeTimeline) formText += `5️⃣ Объём и сроки: ${userData.volumeTimeline}\n`;
  if (userData.executorRequirements) formText += `6️⃣ Требования: ${userData.executorRequirements}\n`;
  if (userData.paymentConditions) formText += `7️⃣ Оплата: ${userData.paymentConditions}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}🤝 *Шаг 8 из 10* — Формат сотрудничества

_Выбери формат из кнопок или напиши свой вариант_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Генподряд', callback_data: 'ord_coop_general' }],
        [{ text: 'Субподряд', callback_data: 'ord_coop_sub' }],
        [{ text: 'По сменам', callback_data: 'ord_coop_shifts' }],
        [{ text: 'Разовый проект', callback_data: 'ord_coop_onetime' }],
        [{ text: 'Долгосрочное сотрудничество', callback_data: 'ord_coop_longterm' }],
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
  let formText = '📋 *Твоя заявка:*\n\n';

  if (userData.requestType) formText += `1️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `2️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `3️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `4️⃣ Работы: ${userData.workType}\n`;
  if (userData.volumeTimeline) formText += `5️⃣ Объём и сроки: ${userData.volumeTimeline}\n`;
  if (userData.executorRequirements) formText += `6️⃣ Требования: ${userData.executorRequirements}\n`;
  if (userData.paymentConditions) formText += `7️⃣ Оплата: ${userData.paymentConditions}\n`;
  if (userData.cooperationFormat) formText += `8️⃣ Формат: ${userData.cooperationFormat}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}📞 *Шаг 9 из 10* — Контактный номер телефона

_Можешь отправить свой контакт кнопкой ниже или написать вручную 👇_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
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
  let formText = '📋 *Твоя заявка:*\n\n';

  if (userData.requestType) formText += `1️⃣ Кого ищешь: ${userData.requestType}\n`;
  if (userData.cityLocation) formText += `2️⃣ Город: ${userData.cityLocation}\n`;
  if (userData.objectType) formText += `3️⃣ Тип объекта: ${userData.objectType}\n`;
  if (userData.workType) formText += `4️⃣ Работы: ${userData.workType}\n`;
  if (userData.volumeTimeline) formText += `5️⃣ Объём и сроки: ${userData.volumeTimeline}\n`;
  if (userData.executorRequirements) formText += `6️⃣ Требования: ${userData.executorRequirements}\n`;
  if (userData.paymentConditions) formText += `7️⃣ Оплата: ${userData.paymentConditions}\n`;
  if (userData.cooperationFormat) formText += `8️⃣ Формат: ${userData.cooperationFormat}\n`;
  if (userData.contact) formText += `9️⃣ Контакт: ${userData.contact}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}✅ *Шаг 10 из 10* — Финальное согласование

*Проверьте правильность ввода данных.*

Если всё верно — нажми *"Подтвердить"*
Если нужно исправить — нажми *"Назад"*`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
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

// ==================== ШАГИ ДЛЯ ВЕТКИ SUPPLIER (ПОСТАВЩИК) ====================

// Шаг 1 Supplier - Тип поставщика
async function askSupplierStep1(chatId, userId) {
  const text = `📝 *Шаг 1 из 8* — Кто вы по формату?

_Выбери из кнопок ниже_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Производитель', callback_data: 'sup_type_manufacturer' }],
        [{ text: 'Поставщик', callback_data: 'sup_type_supplier' }],
        [{ text: 'Аренда техники / механизмов', callback_data: 'sup_type_rent' }],
        [{ text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 2 Supplier - Что поставляете/сдаёте в аренду
async function askSupplierStep2(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя анкета:*\n\n';

  if (userData.supplierType) formText += `1️⃣ Формат: ${userData.supplierType}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}📦 *Шаг 2 из 8* — Что поставляете/сдаёте в аренду?

_Опиши товары, материалы или технику_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'supplier_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 3 Supplier - География работы
async function askSupplierStep3(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя анкета:*\n\n';

  if (userData.supplierType) formText += `1️⃣ Формат: ${userData.supplierType}\n`;
  if (userData.productsServices) formText += `2️⃣ Что поставляете: ${userData.productsServices}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}🌍 *Шаг 3 из 8* — География работы

_Выбери город из кнопок или напиши свой вариант_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Москва', callback_data: 'sup_city_moscow' }],
        [{ text: 'Санкт-Петербург', callback_data: 'sup_city_spb' }],
        [{ text: '◀️ Назад', callback_data: 'supplier_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 4 Supplier - С кем работаете
async function askSupplierStep4(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя анкета:*\n\n';

  if (userData.supplierType) formText += `1️⃣ Формат: ${userData.supplierType}\n`;
  if (userData.productsServices) formText += `2️⃣ Что поставляете: ${userData.productsServices}\n`;
  if (userData.geography) formText += `3️⃣ География: ${userData.geography}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}👥 *Шаг 4 из 8* — С кем работаете?

_Выбери целевую аудиторию из кнопок или напиши свой вариант_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Частники', callback_data: 'sup_aud_private' }],
        [{ text: 'Подрядчики', callback_data: 'sup_aud_contractors' }],
        [{ text: 'Застройщики', callback_data: 'sup_aud_developers' }],
        [{ text: 'Не важно (все)', callback_data: 'sup_aud_all' }],
        [{ text: '◀️ Назад', callback_data: 'supplier_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 5 Supplier - Минимальный заказ и условия
async function askSupplierStep5(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя анкета:*\n\n';

  if (userData.supplierType) formText += `1️⃣ Формат: ${userData.supplierType}\n`;
  if (userData.productsServices) formText += `2️⃣ Что поставляете: ${userData.productsServices}\n`;
  if (userData.geography) formText += `3️⃣ География: ${userData.geography}\n`;
  if (userData.targetAudience) formText += `4️⃣ Для кого: ${userData.targetAudience}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}📋 *Шаг 5 из 8* — Минимальный заказ и условия

_Укажи минимальный заказ, условия поставки/аренды_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'supplier_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ]
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 6 Supplier - Контактный номер телефона
async function askSupplierStep6(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя анкета:*\n\n';

  if (userData.supplierType) formText += `1️⃣ Формат: ${userData.supplierType}\n`;
  if (userData.productsServices) formText += `2️⃣ Что поставляете: ${userData.productsServices}\n`;
  if (userData.geography) formText += `3️⃣ География: ${userData.geography}\n`;
  if (userData.targetAudience) formText += `4️⃣ Для кого: ${userData.targetAudience}\n`;
  if (userData.minOrderConditions) formText += `5️⃣ Условия: ${userData.minOrderConditions}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}📞 *Шаг 6 из 8* — Контактный номер телефона

_Можешь отправить свой контакт кнопкой ниже или написать вручную 👇_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
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

// Шаг 7 Supplier - О компании
async function askSupplierStep7(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя анкета:*\n\n';

  if (userData.supplierType) formText += `1️⃣ Формат: ${userData.supplierType}\n`;
  if (userData.productsServices) formText += `2️⃣ Что поставляете: ${userData.productsServices}\n`;
  if (userData.geography) formText += `3️⃣ География: ${userData.geography}\n`;
  if (userData.targetAudience) formText += `4️⃣ Для кого: ${userData.targetAudience}\n`;
  if (userData.minOrderConditions) formText += `5️⃣ Условия: ${userData.minOrderConditions}\n`;
  if (userData.contact) formText += `6️⃣ Контакт: ${userData.contact}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}🏢 *Шаг 7 из 8* — О компании

_Название компании, имя контактного лица, ссылка на сайт_`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Назад', callback_data: 'supplier_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
      ],
      remove_keyboard: true
    }
  });

  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 8 Supplier - Финальное согласование (проверка данных)
async function askSupplierStep8(chatId, userId) {
  const userData = userStates[userId].data;
  let formText = '📋 *Твоя анкета:*\n\n';

  if (userData.supplierType) formText += `1️⃣ Формат: ${userData.supplierType}\n`;
  if (userData.productsServices) formText += `2️⃣ Что поставляете: ${userData.productsServices}\n`;
  if (userData.geography) formText += `3️⃣ География: ${userData.geography}\n`;
  if (userData.targetAudience) formText += `4️⃣ Для кого: ${userData.targetAudience}\n`;
  if (userData.minOrderConditions) formText += `5️⃣ Условия: ${userData.minOrderConditions}\n`;
  if (userData.contact) formText += `6️⃣ Контакт: ${userData.contact}\n`;
  if (userData.companyInfo) formText += `7️⃣ О компании: ${userData.companyInfo}\n`;

  formText += '\n━━━━━━━━━━━━━━━\n\n';

  const text = `${formText}✅ *Шаг 8 из 8* — Финальное согласование

*Проверьте правильность ввода данных.*

Если всё верно — нажми *"Подтвердить"*
Если нужно исправить — нажми *"Назад"*`;

  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await safeDeleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {}
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Подтвердить', callback_data: 'confirm_supplier_form' }],
        [{ text: '◀️ Назад', callback_data: 'supplier_back' }, { text: '❌ Отменить', callback_data: 'cancel_form' }]
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

  // Пропускаем команды
  if (text && text.startsWith('/')) return;

  // Проверяем, отправляет ли пользователь жалобу
  if (complaintStates[userId]) {
    // Удаляем сообщение пользователя
    try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

    // Удаляем сообщение с просьбой написать жалобу
    if (complaintStates[userId].messageId) {
      try {
        await safeDeleteMessage(chatId, complaintStates[userId].messageId);
      } catch (e) {}
    }

    if (!text || text.trim().length < 10) {
      const errorMsg = await bot.sendMessage(chatId, '❌ Жалоба слишком короткая. Опиши проблему подробнее (минимум 10 символов).');
      deleteMessageAfterDelay(chatId, errorMsg.message_id);
      return;
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
`✅ *Жалоба принята*

📝 Текст жалобы:
_${text.trim()}_

📅 Дата: ${dateStr}

Наш менеджер свяжется с вами для решения этого вопроса.

Спасибо за обратную связь!`,
        {
          parse_mode: 'Markdown',
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
  }

  // Проверяем, заполняет ли пользователь анкету
  if (userStates[userId]) {
    const state = userStates[userId];

    // Обработка кнопки "Назад" (только для шагов с контактами)
    if (text === '◀️ Назад') {
      if (state.formType === 'contractor' && state.step === 9) {
        state.step = 8;
        await askStep8(chatId, userId);
        return;
      } else if (state.formType === 'order' && state.step === 9) {
        state.step = 8;
        await askOrderStep8(chatId, userId);
        return;
      } else if (state.formType === 'supplier' && state.step === 6) {
        state.step = 5;
        await askSupplierStep5(chatId, userId);
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

    // Обработка контакта (contractor шаг 9, order шаг 9, supplier шаг 6)
    if (msg.contact && (
      (state.formType === 'contractor' && state.step === 9) ||
      (state.formType === 'order' && state.step === 9) ||
      (state.formType === 'supplier' && state.step === 6)
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
        await bot.sendMessage(chatId, '❌ Не удалось распознать голос. Попробуй еще раз или напиши текстом.');
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

    // Проверка на пустой ответ (не применяется к шагу 10 - фото)
    if ((!responseText || responseText.trim() === '') && state.step !== 10) {
      await bot.sendMessage(chatId, '❌ Пожалуйста, введи текст или отправь голосовое сообщение.');
      return;
    }

    // ========== ОБРАБОТКА ORDER ФОРМЫ ==========
    if (state.formType === 'order') {
      // Удаляем сообщение пользователя
      try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

      let validation;
      switch (state.step) {
        case 2: // Город и локация
          validation = validateCityLocation(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.cityLocation = responseText.trim();
          state.step = 3;
          await askOrderStep3(chatId, userId);
          break;

        case 3: // Тип объекта (свободный ввод)
          validation = validateCityLocation(responseText); // Используем ту же валидацию
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.objectType = responseText.trim();
          state.step = 4;
          await askOrderStep4(chatId, userId);
          break;

        case 4: // Какие работы нужны
          validation = validateWorkType(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.workType = responseText.trim();
          state.step = 5;
          await askOrderStep5(chatId, userId);
          break;

        case 5: // Объём и сроки
          validation = validateVolumeTimeline(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.volumeTimeline = responseText.trim();
          state.step = 6;
          await askOrderStep6(chatId, userId);
          break;

        case 6: // Требования к исполнителю
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

        case 7: // Условия оплаты
          validation = validatePaymentConditions(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.paymentConditions = responseText.trim();
          state.step = 8;
          await askOrderStep8(chatId, userId);
          break;

        case 8: // Формат сотрудничества (свободный ввод)
          validation = validateCityLocation(responseText); // Базовая валидация
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.cooperationFormat = responseText.trim();
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

    // ========== ОБРАБОТКА SUPPLIER ФОРМЫ ==========
    if (state.formType === 'supplier') {
      // Удаляем сообщение пользователя
      try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

      let validation;
      switch (state.step) {
        case 2: // Что поставляете
          validation = validateProductsServices(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.productsServices = responseText.trim();
          state.step = 3;
          await askSupplierStep3(chatId, userId);
          break;

        case 3: // География (свободный ввод)
          validation = validateGeography(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.geography = responseText.trim();
          state.step = 4;
          await askSupplierStep4(chatId, userId);
          break;

        case 4: // Целевая аудитория (свободный ввод)
          validation = validateGeography(responseText); // Базовая валидация
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.targetAudience = responseText.trim();
          state.step = 5;
          await askSupplierStep5(chatId, userId);
          break;

        case 5: // Минимальный заказ и условия
          validation = validateMinOrderConditions(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.minOrderConditions = responseText.trim();
          state.step = 6;
          await askSupplierStep6(chatId, userId);
          break;

        case 6: // Контактный телефон
          validation = validatePhoneNumber(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.contact = responseText.trim();
          state.step = 7;
          await askSupplierStep7(chatId, userId);
          break;

        case 7: // О компании
          validation = validateCompanyInfo(responseText);
          if (!validation.valid) {
            const errMsg = await bot.sendMessage(chatId, validation.message);
            deleteMessageAfterDelay(chatId, errMsg.message_id);
            return;
          }
          state.data.companyInfo = responseText.trim();

          // Автоматически сохраняем telegram username
          const telegramUsername = msg.from.username;
          state.data.telegramTag = telegramUsername ? `@${telegramUsername}` : null;

          // Переходим на финальное согласование
          state.step = 8;
          await askSupplierStep8(chatId, userId);
          break;

        default:
          break;
      }
      return;
    }

    // ========== ОБРАБОТКА CONTRACTOR ФОРМЫ (по умолчанию) ==========
    // Валидация и сохранение данных по шагам
    let validation;
    switch (state.step) {
      case 1:
        validation = validateWorkFormat(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          // Удаляем сообщение пользователя
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        // Удаляем сообщение пользователя после успешной валидации
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.workFormat = responseText.trim();
        state.step = 2;
        await askStep2(chatId, userId);
        break;

      case 2:
        validation = validateCity(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.city = responseText.trim();
        state.step = 3;
        await askStep3(chatId, userId);
        break;

      case 3:
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

          // Удаляем сообщение "Обрабатываю текст..." через 3 секунды
          setTimeout(() => {
            safeDeleteMessage(chatId, processingMsg.message_id).catch(() => {});
          }, 3000);

          // Показываем пользователю обработанный текст
          if (processedSpecialization !== responseText.trim()) {
            const resultMsg = await bot.sendMessage(chatId, `✨ Текст обработан:\n"${processedSpecialization}"`);

            // Удаляем сообщение "Текст обработан..." через 3 секунды
            setTimeout(() => {
              safeDeleteMessage(chatId, resultMsg.message_id).catch(() => {});
            }, 3000);
          }
        }

        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.specialization = processedSpecialization;
        state.step = 4;
        await askStep4(chatId, userId);
        break;

      case 4:
        validation = validateExperience(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.experience = responseText.trim();
        state.step = 5;
        await askStep5(chatId, userId);
        break;

      case 5:
        validation = validateObjectsWorked(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.objectsWorked = responseText.trim();
        state.step = 6;
        await askStep6(chatId, userId);
        break;

      case 6:
        validation = validateWorkVolume(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.workVolume = responseText.trim();
        state.step = 7;
        await askStep7(chatId, userId);
        break;

      case 7:
        validation = validateDocumentsForm(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.documentsForm = responseText.trim();
        state.step = 8;
        await askStep8(chatId, userId);
        break;

      case 8:
        validation = validatePaymentConditions(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.paymentConditions = responseText.trim();
        state.step = 9;
        await askStep9(chatId, userId);
        break;

      case 9:
        validation = validatePhoneNumber(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.contact = responseText.trim();
        state.step = 10;
        await askStep10(chatId, userId);
        break;

      case 10:
        // На шаге 10 принимаем только фото
        if (msg.photo && msg.photo.length > 0) {
          // Берем фото наибольшего размера (последнее в массиве)
          const photo = msg.photo[msg.photo.length - 1];
          state.data.photoUrl = photo.file_id;

          // Удаляем сообщение пользователя
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

          const confirmMsg = await bot.sendMessage(chatId, '✅ Фото добавлено!');
          deleteMessageAfterDelay(chatId, confirmMsg.message_id);

          state.step = 11;
          await askStep11(chatId, userId);
        } else {
          // Если пользователь отправил не фото, а текст или другой тип файла
          const errMsg = await bot.sendMessage(chatId, '❌ Пожалуйста, отправь фотографию или нажми кнопку "Пропустить"');
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}
        }
        break;
    }

    return;
  }
  
  // Обработка кнопки "Сообщество Голос Стройки"
  if (text === '💬 Сообщество Голос Стройки') {
    // Удаляем сообщение пользователя с кнопкой
    try { await safeDeleteMessage(chatId, msg.message_id); } catch (e) {}

    const communityMsg = await bot.sendMessage(
      chatId,
      `📢 Присоединяйся к нашему сообществу: ${CHANNEL_ID}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📢 Перейти в канал', url: `https://t.me/${CHANNEL_ID.replace('@', '')}` }]
          ]
        }
      }
    );

    // Удаляем сообщение через 10 секунд
    deleteMessageAfterDelay(chatId, communityMsg.message_id, 10000);
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