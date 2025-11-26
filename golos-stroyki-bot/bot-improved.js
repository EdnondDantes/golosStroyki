require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

// Проверка обязательных переменных
if (!BOT_TOKEN) {
  console.error('❌ Ошибка: BOT_TOKEN не установлен в .env файле');
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Ошибка: SUPABASE_URL или SUPABASE_KEY не установлены в .env файле');
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.warn('⚠️ Предупреждение: CHANNEL_ID не установлен - проверка подписки отключена');
}

// Инициализация
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Хранилище состояний пользователей
const userStates = {};

console.log('✅ Бот инициализирован');
console.log(`✅ Подключение к Supabase: ${SUPABASE_URL}`);
console.log(`✅ Проверка подписки на канал: ${CHANNEL_ID || 'отключена'}`);
console.log(`✅ Yandex SpeechKit: ${YANDEX_API_KEY ? 'включен' : 'отключен'}`);

// ==================== УТИЛИТЫ ====================

// Проверка подписки на канал
async function checkSubscription(userId) {
  if (!CHANNEL_ID) return true; // Если канал не настроен, пропускаем проверку
  
  try {
    const member = await bot.getChatMember(CHANNEL_ID, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch (error) {
    console.error('Ошибка проверки подписки:', error.message);
    return false;
  }
}

// Распознавание голоса через Yandex SpeechKit
async function recognizeVoice(fileId) {
  if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) {
    console.warn('⚠️ Yandex SpeechKit не настроен');
    return null;
  }
  
  try {
    // Получаем файл от Telegram
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    
    // Скачиваем файл
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(response.data);
    
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
    console.error('Ошибка распознавания голоса:', error.message);
    return null;
  }
}

// Форматирование текста для Telegram (Markdown)
function escapeMarkdown(text) {
  if (!text) return '';
  return text.toString().replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Сохранение анкеты в Supabase
async function saveContractorToDatabase(data) {
  try {
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
          status: 'pending',
          created_at: new Date().toISOString()
        }
      ]);
    
    if (error) {
      console.error('Ошибка Supabase:', error);
      throw error;
    }
    
    console.log(`✅ Анкета сохранена для пользователя ${data.userId}`);
    return { success: true, data: result };
  } catch (error) {
    console.error('Ошибка сохранения в БД:', error.message);
    return { success: false, error };
  }
}

// ==================== КЛАВИАТУРЫ ====================

const mainMenuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '🔍 Найти подрядчика' }],
      [{ text: '➕ Добавить себя в каталог' }],
      [{ text: '⭕️ Отправить жалобу' }],
      [{ text: '❓ FAQ / Помощь' }],
      [{ text: '💬 Сообщество Голос Стройки' }]
    ],
    resize_keyboard: true
  }
};

const confirmStartFormKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Да, начать', callback_data: 'start_form' }],
      [{ text: '❌ Отмена', callback_data: 'cancel_form' }]
    ]
  }
};

const checkSubscriptionKeyboard = (channelUrl) => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: '✅ Я подписался', callback_data: 'check_subscription' }],
      [{ text: '📢 Перейти в канал', url: channelUrl }]
    ]
  }
});

const cancelKeyboard = {
  reply_markup: {
    keyboard: [
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
  const firstName = msg.from.first_name || 'друг';
  
  console.log(`Пользователь ${username} (${userId}) запустил бота`);
  
  // Проверяем подписку
  const isSubscribed = await checkSubscription(userId);
  
  if (!isSubscribed && CHANNEL_ID) {
    const channelUrl = `https://t.me/${CHANNEL_ID.replace('@', '')}`;
    const welcomeText = `👋 *Привет, ${escapeMarkdown(firstName)}\\!*

📋 Ты в *Каталоге подрядчиков* проекта *Голос Стройки*\\.

Здесь ты можешь:
🔹 найти надёжного подрядчика
🔹 посмотреть реальные профили
🔹 получить контакт
🔹 или добавить себя в каталог \\(если ты мастер/компания\\)

⚠️ *Перед использованием бота нужно быть подписанным на сообщество* ["Голос Стройки"](${channelUrl})`;

    await bot.sendMessage(chatId, welcomeText, {
      parse_mode: 'MarkdownV2',
      ...checkSubscriptionKeyboard(channelUrl),
      disable_web_page_preview: true
    });
    return;
  }
  
  // Если подписан - показываем главное меню
  await showMainMenu(chatId, firstName);
});

// Показать главное меню
async function showMainMenu(chatId, firstName) {
  const menuText = `👋 *Привет, ${escapeMarkdown(firstName || 'друг')}\\!*

Выбери что тебе нужно 👇`;

  await bot.sendMessage(chatId, menuText, {
    parse_mode: 'MarkdownV2',
    ...mainMenuKeyboard
  });
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
    await bot.sendMessage(chatId, '❌ Заполнение анкеты отменено.', mainMenuKeyboard);
    await bot.answerCallbackQuery(query.id);
    return;
  }
  
  await bot.answerCallbackQuery(query.id);
});

// ==================== ПРОЦЕСС АНКЕТЫ ====================

async function startFormProcess(chatId, userId, username) {
  userStates[userId] = {
    step: 1,
    chatId,
    username: username || 'неизвестен',
    data: {}
  };
  
  console.log(`Пользователь ${userId} начал заполнение анкеты`);
  await askStep1(chatId, userId);
}

// Шаг 1 - Имя
async function askStep1(chatId, userId) {
  const text = `📝 *Шаг 1 из 8* — Имя / название компании

Как тебя зовут? Или название компании?

_Можешь ответить текстом или голосовым сообщением 🎤_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...cancelKeyboard
  });
}

// Шаг 2 - Город
async function askStep2(chatId, userId) {
  const text = `📍 *Шаг 2 из 8* — Город

В каком городе работаешь?

_Можешь ответить текстом или голосовым сообщением 🎤_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...cancelKeyboard
  });
}

// Шаг 3 - Специализация
async function askStep3(chatId, userId) {
  const text = `🔧 *Шаг 3 из 8* — Специализация

Кратко напиши чем занимаешься, какие услуги оказываешь?

_Например: "Отделка квартир, малярка, плитка, электрика"_

_Можешь ответить текстом или голосовым сообщением 🎤_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...cancelKeyboard
  });
}

// Шаг 4 - Опыт
async function askStep4(chatId, userId) {
  const text = `⏱ *Шаг 4 из 8* — Опыт работы

Сколько лет опыта?

_Например: "5 лет" или "12 лет"_

_Можешь ответить текстом или голосовым сообщением 🎤_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...cancelKeyboard
  });
}

// Шаг 5 - Описание
async function askStep5(chatId, userId) {
  const text = `✨ *Шаг 5 из 8* — Описание

Кратко расскажи, почему клиент должен выбрать именно тебя?

_Например: "Работаю по договору, даю гарантию 1 год, всегда на связи"_

_Можешь ответить текстом или голосовым сообщением 🎤_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...cancelKeyboard
  });
}

// Шаг 6 - Цены
async function askStep6(chatId, userId) {
  const text = `💵 *Шаг 6 из 8* — Цены

Напиши ориентировочную стоимость твоих услуг

_Например: "от 2000 ₽/м²" или "от 1500 ₽/м² под ключ"_

_Можешь ответить текстом или голосовым сообщением 🎤_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...cancelKeyboard
  });
}

// Шаг 7 - Портфолио
async function askStep7(chatId, userId) {
  const text = `📸 *Шаг 7 из 8* — Примеры работ

Отправь ссылку на ресурс, где можно посмотреть твои работы

_Например: ссылка на Instagram, VK, сайт или Telegram-канал_

_Можешь ответить текстом или голосовым сообщением 🎤_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...cancelKeyboard
  });
}

// Шаг 8 - Контакты
async function askStep8(chatId, userId) {
  const text = `📞 *Шаг 8 из 8* — Контакты

Оставь контакт для клиентов:

— @username (удобнее всего для клиента)
— или номер телефона

_Можешь ответить текстом или голосовым сообщением 🎤_`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...cancelKeyboard
  });
}

// Завершение анкеты
async function finishForm(chatId, userId) {
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
    contact: userData.data.contact
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
  console.log(`Пользователь ${userId} завершил заполнение анкеты`);
}

// ==================== ОБРАБОТКА СООБЩЕНИЙ ====================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  
  // Пропускаем команды
  if (text && text.startsWith('/')) return;
  
  // Проверяем, заполняет ли пользователь анкету
  if (userStates[userId]) {
    const state = userStates[userId];
    
    // Отмена заполнения
    if (text === '❌ Отменить заполнение') {
      delete userStates[userId];
      console.log(`Пользователь ${userId} отменил заполнение анкеты`);
      await bot.sendMessage(chatId, '❌ Заполнение анкеты отменено.', mainMenuKeyboard);
      return;
    }
    
    let responseText = text;
    
    // Обработка голосового сообщения
    if (msg.voice) {
      await bot.sendMessage(chatId, '🎤 Распознаю голосовое сообщение...');
      responseText = await recognizeVoice(msg.voice.file_id);
      
      if (!responseText) {
        await bot.sendMessage(chatId, '❌ Не удалось распознать голос. Попробуй еще раз или напиши текстом.');
        return;
      }
      
      await bot.sendMessage(chatId, `✅ Распознано: "${responseText}"`);
    }
    
    if (!responseText) {
      await bot.sendMessage(chatId, '❌ Пожалуйста, отправь текст или голосовое сообщение.');
      return;
    }
    
    // Валидация и сохранение данных по шагам
    switch (state.step) {
      case 1:
        state.data.name = responseText;
        state.step = 2;
        await askStep2(chatId, userId);
        break;
        
      case 2:
        state.data.city = responseText;
        state.step = 3;
        await askStep3(chatId, userId);
        break;
        
      case 3:
        state.data.specialization = responseText;
        state.step = 4;
        await askStep4(chatId, userId);
        break;
        
      case 4:
        state.data.experience = responseText;
        state.step = 5;
        await askStep5(chatId, userId);
        break;
        
      case 5:
        state.data.description = responseText;
        state.step = 6;
        await askStep6(chatId, userId);
        break;
        
      case 6:
        state.data.price = responseText;
        state.step = 7;
        await askStep7(chatId, userId);
        break;
        
      case 7:
        state.data.portfolioLink = responseText;
        state.step = 8;
        await askStep8(chatId, userId);
        break;
        
      case 8:
        state.data.contact = responseText;
        await finishForm(chatId, userId);
        break;
    }
    
    return;
  }
  
  // Обработка кнопок главного меню
  if (text === '🔍 Найти подрядчика') {
    await bot.sendMessage(chatId, '🚧 Функция поиска подрядчиков находится в разработке.', mainMenuKeyboard);
    return;
  }
  
  if (text === '➕ Добавить себя в каталог') {
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
  
  if (text === '⭕️ Отправить жалобу') {
    await bot.sendMessage(chatId, '📝 Напиши свою жалобу, и мы её рассмотрим.', mainMenuKeyboard);
    return;
  }
  
  if (text === '❓ FAQ / Помощь') {
    const faqText = `❓ *FAQ / Помощь*

📚 Выбери интересующий раздел:

🔹 Как работает каталог?
🔹 Как добавить себя в каталог?
🔹 Сколько стоит размещение?
🔹 Как пожаловаться на подрядчика?`;

    await bot.sendMessage(chatId, faqText, {
      parse_mode: 'Markdown',
      ...mainMenuKeyboard
    });
    return;
  }
  
  if (text === '💬 Сообщество Голос Стройки') {
    const channelUrl = CHANNEL_ID ? `https://t.me/${CHANNEL_ID.replace('@', '')}` : 'https://t.me/golos_stroyki';
    
    await bot.sendMessage(
      chatId,
      `📢 Присоединяйся к нашему сообществу: ${CHANNEL_ID || '@golos_stroyki'}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📢 Перейти в канал', url: channelUrl }]
          ]
        }
      }
    );
    return;
  }
});

// ==================== ОБРАБОТКА ОШИБОК ====================

bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.message);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error);
});

console.log('🤖 Бот запущен успешно!');
console.log('📝 Для остановки нажмите Ctrl+C');
