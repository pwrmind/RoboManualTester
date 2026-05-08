// Функция для связи с фоновым ИИ-скриптом
async function getEmbedding(text) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_EMBEDDING', text }, (response) => {
            resolve(response.embedding);
        });
    });
}

// Косинусное сходство (дублируем логику для панели)
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

document.getElementById('runBtn').addEventListener('click', async () => {
    const scenarioText = document.getElementById('scenario').value;
    const statusDiv = document.getElementById('status');
    const lines = scenarioText.split('\n').filter(l => l.trim() !== '');
    
    statusDiv.innerHTML = "🚀 Запуск... Модель инициализируется.";

    for (const line of lines) {
        const stepDiv = document.createElement('div');
        stepDiv.className = 'step';
        stepDiv.innerText = `⏳ Выполняю: ${line}`;
        statusDiv.appendChild(stepDiv);

        try {
            // 1. Получаем вектор цели из текста шага
            const targetVector = await getEmbedding(line);

            // 2. Опрашиваем страницу на наличие кнопок
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'FIND_AND_CLICK' });
            
            if (response && response.elements) {
                let bestIndex = -1;
                let maxScore = -1;

                // 3. Ищем лучший элемент (сравниваем эмбеддинг шага с текстом кнопок)
                for (let item of response.elements) {
                    const elVector = await getEmbedding(item.text);
                    const score = cosineSimilarity(targetVector, elVector);
                    
                    if (score > maxScore) {
                        maxScore = score;
                        bestIndex = item.id;
                    }
                }

                // 4. Если нашли совпадение (порог 0.5), кликаем
                if (maxScore > 0.5) {
                    await chrome.tabs.sendMessage(tab.id, { 
                        type: 'EXECUTE_CLICK', 
                        index: bestIndex 
                    });
                    stepDiv.className = 'step success';
                    stepDiv.innerText = `✅ Ок (${Math.round(maxScore*100)}%): ${line}`;
                } else {
                    throw new Error("Элемент не найден");
                }
            }
        } catch (err) {
            stepDiv.className = 'step error';
            stepDiv.innerText = `❌ Ошибка: ${line}`;
            break; 
        }
    }
});
