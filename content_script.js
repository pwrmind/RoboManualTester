// Функция для расчета косинусного сходства векторов
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Слушаем команды на поиск и клик
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'FIND_AND_CLICK') {
        const elements = document.querySelectorAll('button, a, input[type="button"], [role="button"]');
        let bestElement = null;
        let maxScore = -1;

        // Это упрощенная логика: в реальности мы бы просили фоновый скрипт 
        // сделать эмбеддинги для каждого элемента, но для MVP сравним тексты
        // (Для полноценной работы нужно передать векторы всех кнопок в background)
        
        // Пока просто возвращаем список всех текстов на странице для анализа
        const elementsData = Array.from(elements).map((el, index) => ({
            id: index,
            text: (el.innerText || el.placeholder || el.ariaLabel || "").trim()
        })).filter(item => item.text.length > 0);

        sendResponse({ elements: elementsData });
    }

    if (request.type === 'EXECUTE_CLICK') {
        const elements = document.querySelectorAll('button, a, input[type="button"], [role="button"]');
        const el = elements[request.index];
        if (el) {
            el.style.outline = "5px solid red"; // Подсветка для жены
            el.click();
            sendResponse({ success: true });
        }
    }
});
