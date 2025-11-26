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

// Функция для автоудаления служебных сообщений
async function deleteMessageAfterDelay(chatId, messageId, delay = 7000) {
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, messageId);
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
    try {
      await bot.deleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
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

  if (userData.name) {
    formText += `👤 Имя: ${userData.name}\n`;
  }
  if (userData.city) {
    formText += `📍 Город: ${userData.city}\n`;
  }
  if (userData.specialization) {
    formText += `🔧 Специализация: ${userData.specialization}\n`;
  }
  if (userData.experience) {
    formText += `⏱ Опыт: ${userData.experience}\n`;
  }
  if (userData.description) {
    formText += `✨ Описание: ${userData.description}\n`;
  }
  if (userData.price) {
    formText += `💵 Цена: ${userData.price}\n`;
  }
  if (userData.portfolioLink) {
    formText += `📸 Портфолио: ${userData.portfolioLink}\n`;
  }
  if (userData.contact) {
    formText += `📞 Контакт: ${userData.contact}\n`;
  }
  if (userData.citizenship) {
    formText += `🌍 Гражданство: ${userData.citizenship}\n`;
  }
  if (userData.photoUrl) {
    formText += `📷 Фото: добавлено\n`;
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
          name: data.name,
          city: data.city,
          specialization: data.specialization,
          experience: data.experience,
          description: data.description,
          price: data.price,
          portfolio_link: data.portfolioLink,
          contact: data.contact,
          citizenship: data.citizenship,
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
  await showMainMenu(chatId, msg.from.first_name);
});

// Показать главное меню
async function showMainMenu(chatId, firstName) {
  const menuText = `👋 Привет, ${firstName || 'друг'}!

Выбери что тебе нужно 👇`;

  // Сначала устанавливаем обычную клавиатуру
  const tempMessage = await bot.sendMessage(chatId, '💬 Используй кнопку ниже для перехода в сообщество', communityKeyboard);

  // Удаляем это сообщение через 3 секунды
  setTimeout(async () => {
    try {
      await bot.deleteMessage(chatId, tempMessage.message_id);
    } catch (error) {
      // Игнорируем ошибку, если сообщение уже удалено
      console.log('Сообщение уже удалено или недоступно');
    }
  }, 8000);

  // Затем отправляем сообщение с инлайн-кнопками и сохраняем ID
  const menuMessage = await bot.sendMessage(chatId, menuText, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔍 Найти подрядчика', callback_data: 'search_contractor' }],
        [{ text: '➕ Добавить себя в каталог', callback_data: 'add_to_catalog' }],
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
      await bot.deleteMessage(chatId, query.message.message_id);
      await showMainMenu(chatId, query.from.first_name);
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
    await bot.deleteMessage(chatId, query.message.message_id);
    await startFormProcess(chatId, userId, query.from.username);
    await bot.answerCallbackQuery(query.id);
    return;
  }
  
  // Отмена анкеты
  if (data === 'cancel_form') {
    await bot.deleteMessage(chatId, query.message.message_id);
    const cancelMsg = await bot.sendMessage(chatId, '❌ Заполнение анкеты отменено.', mainMenuKeyboard);
    deleteMessageAfterDelay(chatId, cancelMsg.message_id);
    await bot.answerCallbackQuery(query.id);
    await showMainMenu(chatId, query.from.first_name);
    return;
  }

  // Обработка кнопок главного меню (inline)
  if (data === 'search_contractor') {
    // Удаляем меню
    if (liveMessages[chatId] && liveMessages[chatId].menuMessageId) {
      try {
        await bot.deleteMessage(chatId, liveMessages[chatId].menuMessageId);
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

  if (data === 'add_to_catalog') {
    // Удаляем меню
    if (liveMessages[chatId] && liveMessages[chatId].menuMessageId) {
      try {
        await bot.deleteMessage(chatId, liveMessages[chatId].menuMessageId);
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

  if (data === 'send_complaint') {
    // Удаляем меню
    if (liveMessages[chatId] && liveMessages[chatId].menuMessageId) {
      try {
        await bot.deleteMessage(chatId, liveMessages[chatId].menuMessageId);
      } catch (error) {
        console.log('Меню уже удалено');
      }
    }
    await bot.answerCallbackQuery(query.id);

    // Инициализируем состояние жалобы
    complaintStates[userId] = { active: true };

    const complaintMsg = await bot.sendMessage(chatId, '📝 Напиши свою жалобу, и мы её рассмотрим.\n\n_Минимум 10 символов_', {
      parse_mode: 'Markdown',
      ...communityKeyboard
    });

    // Сохраняем ID сообщения для возможного удаления позже
    complaintStates[userId].messageId = complaintMsg.message_id;
    return;
  }

  if (data === 'faq_help') {
    await bot.answerCallbackQuery(query.id);
    // Удаляем предыдущее сообщение (главное меню или ответ на вопрос)
    await bot.deleteMessage(chatId, query.message.message_id);

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
    await bot.deleteMessage(chatId, query.message.message_id);

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
    await bot.deleteMessage(chatId, query.message.message_id);

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
    await bot.deleteMessage(chatId, query.message.message_id);

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
    await bot.deleteMessage(chatId, query.message.message_id);

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
    await bot.deleteMessage(chatId, query.message.message_id);
    await showMainMenu(chatId, query.from.first_name);
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
  // Инициализируем состояние пользователя
  userStates[userId] = {
    step: 1,
    chatId,
    username: username || 'неизвестен',
    data: {}
  };
  
  await askStep1(chatId, userId);
}

// Шаг 1 - Имя
async function askStep1(chatId, userId) {
  const text = `📝 *Шаг 1 из 9* — Имя / название компании

Как тебя зовут? Или название компании?

_Можешь ответить текстом или голосовым сообщением 🎤_`;

  // Удаляем предыдущее сообщение шага если оно есть
  if (liveMessages[userId] && liveMessages[userId].formStepMessageId) {
    try {
      await bot.deleteMessage(chatId, liveMessages[userId].formStepMessageId);
    } catch (error) {
      // Игнорируем ошибку если сообщение уже удалено
    }
  }

  const msg = await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...cancelKeyboard
  });

  // Сохраняем ID сообщения шага
  if (!liveMessages[userId]) liveMessages[userId] = {};
  liveMessages[userId].formStepMessageId = msg.message_id;
}

// Шаг 2 - Город
async function askStep2(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 2);

  const text = `${formData}📍 *Шаг 2 из 9* — Город

В каком городе работаешь?`;

  await sendOrEditStepMessage(chatId, userId, text, cancelWithBackKeyboard);
}

// Шаг 3 - Специализация
async function askStep3(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 3);

  const text = `${formData}🔧 *Шаг 3 из 9* — Специализация

Кратко напиши чем занимаешься, какие услуги оказываешь?

_Например: "Отделка квартир, малярка, плитка, электрика"_`;

  await sendOrEditStepMessage(chatId, userId, text, cancelWithBackKeyboard);
}

// Шаг 4 - Опыт
async function askStep4(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 4);

  const text = `${formData}⏱ *Шаг 4 из 9* — Опыт работы

Сколько лет опыта?

_Например: "5 лет" или "12 лет"_`;

  await sendOrEditStepMessage(chatId, userId, text, cancelWithBackKeyboard);
}

// Шаг 5 - Описание
async function askStep5(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 5);

  const text = `${formData}✨ *Шаг 5 из 9* — Описание

Кратко расскажи, почему клиент должен выбрать именно тебя?

_Например: "Работаю по договору, даю гарантию 1 год, всегда на связи"_`;

  await sendOrEditStepMessage(chatId, userId, text, cancelWithBackKeyboard);
}

// Шаг 6 - Цены
async function askStep6(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 6);

  const text = `${formData}💵 *Шаг 6 из 9* — Цены

Напиши ориентировочную стоимость твоих услуг

_Например: "от 2000 ₽/м²" или "от 1500 ₽/м² под ключ"_`;

  await sendOrEditStepMessage(chatId, userId, text, cancelWithBackKeyboard);
}

// Шаг 7 - Портфолио
async function askStep7(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 7);

  const text = `${formData}📸 *Шаг 7 из 9* — Примеры работ

Отправь ссылку на ресурс, где можно посмотреть твои работы

_Например: ссылка на Instagram, VK, сайт или Telegram-канал_`;

  await sendOrEditStepMessage(chatId, userId, text, cancelWithBackKeyboard);
}

// Шаг 8 - Контакты
async function askStep8(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 8);

  const text = `${formData}📞 *Шаг 8 из 9* — Контакты

Оставь номер телефона для клиентов:

_Можешь отправить свой контакт кнопкой ниже 👇_`;

  await sendOrEditStepMessage(chatId, userId, text, {
    reply_markup: {
      keyboard: [
        [{ text: '📱 Отправить мой контакт', request_contact: true }],
        [{ text: '◀️ Назад' }],
        [{ text: '❌ Отменить заполнение' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
}

// Шаг 9 - Гражданство
async function askStep9(chatId, userId) {
  const userData = userStates[userId].data;
  const formData = formatCurrentFormData(userData, 9);

  const text = `${formData}🌍 *Шаг 9 из 9* — Гражданство

Укажи своё гражданство:

_Например: Россия, Казахстан, Беларусь_`;

  await sendOrEditStepMessage(chatId, userId, text, cancelWithBackKeyboard);
}

// Завершение анкеты
async function finishForm(chatId, userId, telegramUsername) {
  const userData = userStates[userId];

  // Сохраняем в базу данных
  const result = await saveContractorToDatabase({
    userId,
    username: userData.username,
    name: userData.data.name,
    city: userData.data.city,
    specialization: userData.data.specialization,
    experience: userData.data.experience,
    description: userData.data.description,
    price: userData.data.price,
    portfolioLink: userData.data.portfolioLink,
    contact: userData.data.contact,
    citizenship: userData.data.citizenship,
    photoUrl: userData.data.photoUrl,
    telegramTag: telegramUsername ? `@${telegramUsername}` : null
  });
  
  if (result.success) {
    const successText = `🎉 *Отлично\\!*

Твоя анкета отправлена на модерацию\\.

Когда карточка будет утверждена — мы пришлём уведомление\\.

📋 *Твои данные:*
👤 Имя: ${escapeMarkdown(userData.data.name)}
📍 Город: ${escapeMarkdown(userData.data.city)}
🔧 Специализация: ${escapeMarkdown(userData.data.specialization)}
⏱ Опыт: ${escapeMarkdown(userData.data.experience)}
✨ Описание: ${escapeMarkdown(userData.data.description)}
💵 Цена: ${escapeMarkdown(userData.data.price)}
📸 Портфолио: ${escapeMarkdown(userData.data.portfolioLink)}
📞 Контакт: ${escapeMarkdown(userData.data.contact)}
🌍 Гражданство: ${escapeMarkdown(userData.data.citizenship)}
📷 Фото: ${userData.data.photoUrl ? 'добавлено' : 'не добавлено'}`;

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
  await showMainMenu(chatId, userData.data.name);
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
    try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

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
      const successMsg = await bot.sendMessage(chatId, '✅ Спасибо! Твоя жалоба принята и будет рассмотрена.', mainMenuKeyboard);
      deleteMessageAfterDelay(chatId, successMsg.message_id);
      await showMainMenu(chatId, msg.from.first_name);
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
      await showMainMenu(chatId, msg.from.first_name);
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

    // Отмена заполнения
    if (text === '❌ Отменить заполнение') {
      // Удаляем сообщение пользователя с кнопкой
      try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
      delete userStates[userId];
      const cancelMsg = await bot.sendMessage(chatId, '❌ Заполнение анкеты отменено.', mainMenuKeyboard);
      deleteMessageAfterDelay(chatId, cancelMsg.message_id);
      await showMainMenu(chatId, msg.from.first_name);
      return;
    }

    // Обработка кнопки "Назад"
    if (text === '◀️ Назад') {
      // Удаляем сообщение пользователя с кнопкой
      try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

      if (state.step > 1) {
        state.step -= 1;

        // Вызываем соответствующий шаг
        switch (state.step) {
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
        }
        return;
      }
    }

    let responseText = text;

    // Обработка контакта (шаг 8)
    if (msg.contact && state.step === 8) {
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

      // Обработка голосового текста через Deepseek для шагов 3 и 5
      if (state.step === 3 || state.step === 5) {
        const processingMsg = await bot.sendMessage(chatId, '🤖 Обрабатываю текст...');
        const fieldType = state.step === 3 ? 'specialization' : 'description';
        const processedText = await processTextWithDeepseek(responseText, fieldType);

        // Удаляем сообщение "Обрабатываю текст..." через 3 секунды
        setTimeout(() => {
          bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
        }, 3000);

        if (processedText !== responseText) {
          const resultMsg = await bot.sendMessage(chatId, `✨ Текст обработан:\n"${processedText}"`);
          responseText = processedText;
          isTextProcessed = true; // Помечаем, что текст уже обработан

          // Удаляем сообщение "Текст обработан..." через 3 секунды
          setTimeout(() => {
            bot.deleteMessage(chatId, resultMsg.message_id).catch(() => {});
          }, 3000);
        }
      }
    }

    // Проверка на пустой ответ (не применяется к шагу 10 - фото)
    if ((!responseText || responseText.trim() === '') && state.step !== 10) {
      await bot.sendMessage(chatId, '❌ Пожалуйста, введи текст или отправь голосовое сообщение.');
      return;
    }

    // Валидация и сохранение данных по шагам
    let validation;
    switch (state.step) {
      case 1:
        validation = validateName(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          // Удаляем сообщение пользователя
          try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        // Удаляем сообщение пользователя после успешной валидации
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.name = responseText.trim();
        state.step = 2;
        await askStep2(chatId, userId);
        break;

      case 2:
        validation = validateCity(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.city = responseText.trim();
        state.step = 3;
        await askStep3(chatId, userId);
        break;

      case 3:
        validation = validateSpecialization(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }

        let processedSpecialization = responseText.trim();

        // Обработка текста через Deepseek только если он еще не был обработан
        if (!isTextProcessed) {
          const processingMsg = await bot.sendMessage(chatId, '🤖 Обрабатываю текст...');
          processedSpecialization = await processTextWithDeepseek(responseText.trim(), 'specialization');

          // Удаляем сообщение "Обрабатываю текст..." через 3 секунды
          setTimeout(() => {
            bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
          }, 3000);

          // Показываем пользователю обработанный текст
          if (processedSpecialization !== responseText.trim()) {
            const resultMsg = await bot.sendMessage(chatId, `✨ Текст обработан:\n"${processedSpecialization}"`);

            // Удаляем сообщение "Текст обработан..." через 3 секунды
            setTimeout(() => {
              bot.deleteMessage(chatId, resultMsg.message_id).catch(() => {});
            }, 3000);
          }
        }

        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.specialization = processedSpecialization;
        state.step = 4;
        await askStep4(chatId, userId);
        break;

      case 4:
        validation = validateExperience(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.experience = responseText.trim();
        state.step = 5;
        await askStep5(chatId, userId);
        break;

      case 5:
        validation = validateDescription(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }

        let processedDescription = responseText.trim();

        // Обработка текста через Deepseek только если он еще не был обработан
        if (!isTextProcessed) {
          const processingMsg = await bot.sendMessage(chatId, '🤖 Обрабатываю текст...');
          processedDescription = await processTextWithDeepseek(responseText.trim(), 'description');

          // Удаляем сообщение "Обрабатываю текст..." через 3 секунды
          setTimeout(() => {
            bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
          }, 3000);

          // Показываем пользователю обработанный текст
          if (processedDescription !== responseText.trim()) {
            const resultMsg = await bot.sendMessage(chatId, `✨ Текст обработан:\n"${processedDescription}"`);

            // Удаляем сообщение "Текст обработан..." через 3 секунды
            setTimeout(() => {
              bot.deleteMessage(chatId, resultMsg.message_id).catch(() => {});
            }, 3000);
          }
        }

        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.description = processedDescription;
        state.step = 6;
        await askStep6(chatId, userId);
        break;

      case 6:
        validation = validatePrice(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.price = responseText.trim();
        state.step = 7;
        await askStep7(chatId, userId);
        break;

      case 7:
        validation = validatePortfolio(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.portfolioLink = responseText.trim();
        state.step = 8;
        await askStep8(chatId, userId);
        break;

      case 8:
        validation = validateContact(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.contact = responseText.trim();
        state.step = 9;
        await askStep9(chatId, userId);
        break;

      case 9:
        validation = validateCitizenship(responseText);
        if (!validation.valid) {
          const errMsg = await bot.sendMessage(chatId, validation.message);
          deleteMessageAfterDelay(chatId, errMsg.message_id);
          try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
          return;
        }
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        state.data.citizenship = responseText.trim();

        // Получаем фото профиля пользователя из Telegram
        try {
          const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
          if (photos.total_count > 0 && photos.photos.length > 0) {
            // Берем фото наибольшего размера
            const photo = photos.photos[0][photos.photos[0].length - 1];
            state.data.photoUrl = photo.file_id;
          } else {
            state.data.photoUrl = null;
          }
        } catch (error) {
          console.error('Ошибка получения фото профиля:', error);
          state.data.photoUrl = null;
        }

        await finishForm(chatId, userId, msg.from.username);
        break;
    }

    return;
  }
  
  // Обработка кнопки "Сообщество Голос Стройки"
  if (text === '💬 Сообщество Голос Стройки') {
    // Удаляем сообщение пользователя с кнопкой
    try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

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