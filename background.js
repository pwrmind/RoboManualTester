// Импортируем напрямую из файла. 
// Путь должен быть относительным и точным.
import { pipeline, env } from './lib/transformers.min.js';

// Настройки
env.allowLocalModels = false;
env.useBrowserCache = true;

let extractor = null;

async function initModel() {
    if (!extractor) {
        console.log("Загрузка модели...");
        try {
            // Для русского языка
            extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
                quantized: true
            });
            console.log("Модель готова!");
        } catch (e) {
            console.error("Ошибка инициализации:", e);
        }
    }
}

// Слушаем сообщения
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_EMBEDDING') {
        initModel().then(async () => {
            if (!extractor) return sendResponse({ error: "No model" });
            const output = await extractor(message.text, { pooling: 'mean', normalize: true });
            sendResponse({ embedding: Array.from(output.data) });
        });
        return true; 
    }
});
