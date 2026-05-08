// Импортируем библиотеку Transformers.js из локального файла
import { pipeline, env } from './lib/transformers.min.js';

// Настройка окружения
env.allowLocalModels = false;       // не используем локальные модели
env.useBrowserCache = true;        // разрешаем кеширование в браузере

let extractor = null;

// Инициализация модели (мультиязычная, понимает русский)
async function initModel() {
  if (!extractor) {
    console.log('Загрузка multilingual модели...');
    try {
      extractor = await pipeline(
        'feature-extraction',
        'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
        { quantized: true } // квантизация для экономии памяти
      );
      console.log('Модель готова к работе');
    } catch (err) {
      console.error('Ошибка загрузки модели:', err);
      extractor = null;
    }
  }
}

// Обработчик сообщений от side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_EMBEDDING') {
    (async () => {
      await initModel();
      if (!extractor) {
        sendResponse({ error: 'Модель не загружена' });
        return;
      }
      try {
        const output = await extractor(message.text, {
          pooling: 'mean',
          normalize: true
        });
        // Возвращаем обычный массив чисел
        sendResponse({ embedding: Array.from(output.data) });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true; // для асинхронного ответа
  }
});