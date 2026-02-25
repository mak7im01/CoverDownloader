// Аддон для скачивания обложек треков в PulseSync

(function() {
    'use strict';

    let downloadButton = null;
    let currentCoverUrl = null;
    let currentTrackInfo = null;
    let lastTrackId = null;
    let settings = null;
    let isDownloading = false; // Флаг для предотвращения обновлений во время скачивания
    let isUpdating = false; // Флаг для предотвращения множественных обновлений
    let currentContainer = null; // Текущий контейнер кнопки

    // Получение настроек
    async function getSettings(name) {
        try {
            const response = await fetch(`http://localhost:2007/get_handle?name=${name}`);
            if (!response.ok) throw new Error(`Ошибка сети: ${response.status}`);
      
            const { data } = await response.json();
            if (!data?.sections) {
                console.warn("Структура данных не соответствует ожидаемой");
                return null;
            }

            return transformJSON(data);
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    // "Трансформирование" полученных настроек для более удобного использования
    function transformJSON(data) {
        const result = {};

        try {
            data.sections.forEach(section => {
                section.items.forEach(item => {
                    if (item.type === "text" && item.buttons) {
                        result[item.id] = {};
                        item.buttons.forEach(button => {
                            result[item.id][button.id] = {
                                value: button.text,
                                default: button.defaultParameter
                            };
                        });
                    } else {
                        result[item.id] = {
                            value: item.bool || item.input || item.selected || item.value || item.filePath,
                            default: item.defaultParameter
                        };
                    }
                });
            });
        } finally {
            return result;
        }
    }

    // Функция для получения уникального ID трека
    function getTrackId() {
        try {
            const fullscreenModal = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
            if (!fullscreenModal) return null;

            // Получаем ID из ссылки на трек
            const trackLink = fullscreenModal.querySelector('a[href*="/album/track?albumId="]');
            if (trackLink) {
                const href = trackLink.getAttribute('href');
                const match = href.match(/trackId=(\d+)/);
                return match ? match[1] : null;
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    // Функция для получения информации о текущем треке из DOM
    function getCurrentTrackInfo() {
        try {
            const fullscreenModal = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
            if (!fullscreenModal) return null;

            let artist = 'Unknown';
            let title = 'Unknown';

            // Пытаемся получить информацию из ссылок (для онлайн треков)
            const artistLink = fullscreenModal.querySelector('a[href*="/artist?artistId="]');
            const trackLink = fullscreenModal.querySelector('a[href*="/album/track?albumId="]');
            
            if (artistLink && trackLink) {
                // Онлайн трек
                artist = artistLink.textContent.trim();
                title = trackLink.textContent.trim();
            } else {
                // Локальный трек - ищем информацию в других элементах
                // Ищем все текстовые элементы в модальном окне
                const titleElements = fullscreenModal.querySelectorAll('[class*="Title"], [class*="title"]');
                const artistElements = fullscreenModal.querySelectorAll('[class*="Artist"], [class*="artist"], [class*="Subtitle"], [class*="subtitle"]');
                
                // Пытаемся найти название трека
                for (const elem of titleElements) {
                    const text = elem.textContent.trim();
                    if (text && text.length > 0 && !text.includes('•') && text !== artist) {
                        title = text;
                        break;
                    }
                }
                
                // Пытаемся найти исполнителя
                for (const elem of artistElements) {
                    const text = elem.textContent.trim();
                    if (text && text.length > 0 && !text.includes('•') && text !== title) {
                        artist = text;
                        break;
                    }
                }
                
                // Если не нашли через классы, пробуем через структуру
                if (artist === 'Unknown' || title === 'Unknown') {
                    // Ищем элементы с текстом рядом с обложкой
                    const textElements = fullscreenModal.querySelectorAll('div[class*="Text"], span[class*="Text"]');
                    const texts = Array.from(textElements)
                        .map(el => el.textContent.trim())
                        .filter(text => text && text.length > 0 && text.length < 200);
                    
                    if (texts.length >= 2) {
                        if (title === 'Unknown') title = texts[0];
                        if (artist === 'Unknown') artist = texts[1];
                    } else if (texts.length === 1) {
                        if (title === 'Unknown') title = texts[0];
                    }
                }
            }

            return { artist, title };
        } catch (error) {
            console.error('Ошибка получения информации о треке:', error);
            return null;
        }
    }

    // Функция для проверки, является ли трек локальным
    function isLocalTrack() {
        try {
            const fullscreenModal = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
            if (!fullscreenModal) return false;

            // Локальные треки не имеют ссылок на исполнителя и альбом
            const artistLink = fullscreenModal.querySelector('a[href*="/artist?artistId="]');
            const trackLink = fullscreenModal.querySelector('a[href*="/album/track?albumId="]');
            
            return !artistLink && !trackLink;
        } catch (error) {
            return false;
        }
    }

    // Функция для получения URL обложки
    function getCoverUrl() {
        // Ищем обложку в полноэкранном плеере
        const fullscreenModal = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
        if (!fullscreenModal) return null;

        // Ищем изображение обложки
        const coverImage = fullscreenModal.querySelector('img[src*="avatars.yandex.net"], img[src*="music.yandex"]');
        if (coverImage && coverImage.src) {
            let url = coverImage.src;
            
            // Определяем размер на основе настроек
            let size = 'orig'; // По умолчанию оригинальное качество
            
            if (settings) {
                if (settings.imageQuality) {
                    const quality = settings.imageQuality.value;
                    if (quality === 1) size = '200x200';
                    else if (quality === 2) size = '400x400';
                    else if (quality === 3) size = '1000x1000';
                    else if (quality === 4) size = 'orig'; // Оригинальный размер
                } else if (settings.imageSize) {
                    const customSize = settings.imageSize.value;
                    size = `${customSize}x${customSize}`;
                }
            }
            
            // Заменяем размер
            if (size === 'orig') {
                // Для оригинального размера удаляем параметр размера
                url = url.replace(/\/\d+x\d+/, '/orig');
            } else {
                url = url.replace(/\/\d+x\d+/, `/${size}`);
            }
            return url;
        }

        return null;
    }

    // Функция для скачивания обложки
    async function downloadCover() {
        if (!currentCoverUrl) {
            console.error('URL обложки не найден');
            return;
        }

        if (isDownloading) {
            console.log('Скачивание уже выполняется');
            return;
        }

        try {
            isDownloading = true; // Устанавливаем флаг
            
            // Получаем информацию о треке для имени файла
            const trackInfo = getCurrentTrackInfo();
            
            let filename = 'cover.jpg';
            
            if (trackInfo && trackInfo.artist && trackInfo.title && 
                trackInfo.artist !== 'Unknown' && trackInfo.title !== 'Unknown') {
                const artist = trackInfo.artist;
                const title = trackInfo.title;
                
                // Используем шаблон из настроек, если он есть
                if (settings && settings.fileNameFormat && settings.fileNameFormat.fileNamePattern) {
                    const pattern = settings.fileNameFormat.fileNamePattern.value;
                    filename = pattern
                        .replace('{artist}', artist)
                        .replace('{title}', title)
                        + '.jpg';
                } else {
                    filename = `${artist} - ${title}.jpg`;
                }
                
                // Очищаем имя файла от недопустимых символов
                filename = filename.replace(/[/\\?%*:|"<>]/g, '-');
            } else {
                // Если не удалось получить информацию о треке, используем "cover"
                filename = 'cover.jpg';
            }

            // Скачиваем изображение
            const response = await fetch(currentCoverUrl);
            const blob = await response.blob();
            
            // Используем File System Access API для выбора места сохранения
            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: [{
                            description: 'Изображения',
                            accept: { 'image/jpeg': ['.jpg', '.jpeg'] }
                        }]
                    });
                    
                    const writable = await handle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    
                    console.log('Обложка сохранена:', filename);
                    
                    // Показываем уведомление, если включено в настройках
                    if (settings && settings.showNotifications && settings.showNotifications.value) {
                        showNotification('Обложка сохранена', filename);
                    }
                } catch (err) {
                    // Пользователь отменил сохранение
                    if (err.name !== 'AbortError') {
                        console.error('Ошибка при сохранении:', err);
                    }
                }
            } else {
                // Fallback для браузеров без поддержки File System Access API
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                
                // Очищаем
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                
                console.log('Обложка скачана:', filename);
                
                // Показываем уведомление, если включено в настройках
                if (settings && settings.showNotifications && settings.showNotifications.value) {
                    showNotification('Обложка скачана', filename);
                }
            }
        } catch (error) {
            console.error('Ошибка при скачивании обложки:', error);
        } finally {
            isDownloading = false; // Снимаем флаг
        }
    }

    // Функция для показа уведомлений
    function showNotification(title, message) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, {
                body: message,
                icon: currentCoverUrl
            });
        }
    }

    // Запрос разрешения на уведомления
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    // Функция для создания кнопки скачивания
    function createDownloadButton() {
        const button = document.createElement('button');
        button.className = 'cover-download-button';
        button.innerHTML = `
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
        `;
        
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            downloadCover();
        });
        
        return button;
    }

    // Функция для добавления кнопки в полноэкранный плеер
    function addDownloadButton() {
        // Блокируем обновление во время скачивания или если уже идет обновление
        if (isDownloading || isUpdating) {
            return;
        }

        isUpdating = true;

        try {
            const fullscreenModal = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
            
            if (!fullscreenModal) {
                // Если модальное окно закрыто, удаляем кнопку и очищаем состояние
                if (downloadButton && downloadButton.parentNode) {
                    downloadButton.parentNode.removeChild(downloadButton);
                    downloadButton = null;
                }
                lastTrackId = null;
                currentCoverUrl = null;
                currentTrackInfo = null;
                currentContainer = null;
                return;
            }

            // Проверяем, изменился ли трек
            const currentTrackId = getTrackId();
            
            // Если трек не изменился и кнопка уже существует в правильном контейнере
            if (currentTrackId && currentTrackId === lastTrackId && 
                downloadButton && downloadButton.parentNode && 
                currentContainer && currentContainer.contains(downloadButton)) {
                // Все в порядке, кнопка на месте, ничего не делаем
                return;
            }

            // Трек изменился или кнопка потерялась, обновляем ID
            lastTrackId = currentTrackId;

            // Ищем контейнер с обложкой
            const coverImage = fullscreenModal.querySelector('img[src*="avatars.yandex.net"], img[src*="music.yandex"]');
            if (!coverImage) {
                return;
            }

            // Проверяем, загружена ли обложка
            if (!coverImage.complete || coverImage.naturalHeight === 0) {
                // Обложка еще не загружена, ждем загрузки
                coverImage.addEventListener('load', () => {
                    isUpdating = false;
                    addDownloadButton();
                }, { once: true });
                return;
            }

            // Находим родительский контейнер обложки
            const coverContainer = coverImage.closest('div[class*="CoverStack"], div[class*="Cover"]') || coverImage.parentElement;
            if (!coverContainer) {
                return;
            }

            // Если контейнер не изменился и кнопка на месте - не пересоздаем
            if (coverContainer === currentContainer && downloadButton && coverContainer.contains(downloadButton)) {
                return;
            }

            // Удаляем старую кнопку, если она есть
            if (downloadButton && downloadButton.parentNode) {
                downloadButton.parentNode.removeChild(downloadButton);
            }

            // Получаем URL обложки
            currentCoverUrl = getCoverUrl();
            if (!currentCoverUrl) {
                return;
            }

            // Убеждаемся, что контейнер имеет position: relative
            if (getComputedStyle(coverContainer).position === 'static') {
                coverContainer.style.position = 'relative';
            }

            // Добавляем класс для управления видимостью кнопки
            coverContainer.classList.add('cover-download-button-container');

            // Создаем и добавляем кнопку
            downloadButton = createDownloadButton();
            coverContainer.appendChild(downloadButton);
            
            // Сохраняем ссылку на текущий контейнер
            currentContainer = coverContainer;
        } finally {
            isUpdating = false;
        }
    }

    // Единый наблюдатель за изменениями DOM с debounce
    let updateTimeout = null;
    const observer = new MutationObserver((mutations) => {
        // Игнорируем изменения во время скачивания или обновления
        if (isDownloading || isUpdating) {
            return;
        }

        // Проверяем, есть ли релевантные изменения
        let shouldUpdate = false;
        
        for (const mutation of mutations) {
            // Игнорируем изменения внутри кнопки или её контейнера
            let node = mutation.target;
            let isInsideButton = false;
            
            // Проверяем, не находится ли изменение внутри кнопки или её контейнера
            while (node && node !== document.body) {
                if (node.classList) {
                    if (node.classList.contains('cover-download-button') || 
                        node.classList.contains('cover-download-button-container')) {
                        isInsideButton = true;
                        break;
                    }
                }
                node = node.parentNode;
            }
            
            if (isInsideButton) {
                continue;
            }
            
            // Проверяем добавленные узлы
            for (const addedNode of mutation.addedNodes) {
                if (addedNode.nodeType === 1) { // Element node
                    // Игнорируем если это сама кнопка
                    if (addedNode.classList && addedNode.classList.contains('cover-download-button')) {
                        continue;
                    }
                    shouldUpdate = true;
                    break;
                }
            }
            
            // Проверяем удаленные узлы
            for (const removedNode of mutation.removedNodes) {
                if (removedNode.nodeType === 1) {
                    // Игнорируем если это сама кнопка
                    if (removedNode.classList && removedNode.classList.contains('cover-download-button')) {
                        continue;
                    }
                    shouldUpdate = true;
                    break;
                }
            }
            
            if (shouldUpdate) break;
        }

        if (!shouldUpdate) {
            return;
        }

        // Используем debounce чтобы избежать множественных вызовов
        if (updateTimeout) clearTimeout(updateTimeout);
        updateTimeout = setTimeout(() => {
            addDownloadButton();
        }, 200);
    });

    // Запускаем наблюдение только за структурными изменениями (childList)
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Обновляем настройки каждые 3 секунды (увеличен интервал для снижения нагрузки)
    setInterval(async () => {
        settings = await getSettings("CoverDownloader");
        
        // Автоматическое скачивание, если включено
        if (settings && settings.autoDownload && settings.autoDownload.value) {
            const currentTrackId = getTrackId();
            if (currentTrackId && currentTrackId !== lastTrackId) {
                const fullscreenModal = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
                if (fullscreenModal) {
                    currentCoverUrl = getCoverUrl();
                    if (currentCoverUrl) {
                        await downloadCover();
                    }
                }
            }
        }
    }, 3000);

    console.log('CoverDownloader аддон загружен');
})();
