require('dotenv').config();

module.exports = {
  telegram: {
    token: process.env.BOT_TOKEN,
    channelId: process.env.CHANNEL_ID
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_KEY
  },
  yandex: {
    apiKey: process.env.YANDEX_API_KEY,
    folderId: process.env.YANDEX_FOLDER_ID
  }
};
