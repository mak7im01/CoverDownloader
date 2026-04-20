// Аддон для скачивания обложек треков в PulseSync

(function() {
    'use strict';

    let downloadButton = null;
    let currentCoverUrl = null;
    let lastTrackId = null;
    let settings = null;
    let isDownloading = false;
    let isUpdating = false;
    let currentContainer = null;

    // ─── Настройки ────────────────────────────────────────────────────────────

    async function getSettings(name) {
        try {
            const response = await fetch(`http://localhost:2007/get_handle?name=${name}`);
            if (!response.ok) throw new Error(`Ошибка сети: ${response.status}`);
            const { data } = await response.json();
            if (!data?.sections) return null;
            return transformJSON(data);
        } catch (error) {
            console.error('[CoverDownloader] getSettings:', error);
            return null;
        }
    }

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

    // ─── DOM-хелперы ──────────────────────────────────────────────────────────

    function getModal() {
        return document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
    }

    // Контейнер постера — именно сюда добавляем кнопку
    function getPosterContainer(modal) {
        return modal.querySelector('[data-test-id="FULLSCREEN_PLAYER_POSTER_CONTENT"]');
    }

    // Изображение обложки
    function getCoverImage(modal) {
        // Точный data-test-id из реального DOM
        const byTestId = modal.querySelector('img[data-test-id="ENTITY_COVER_IMAGE"]');
        if (byTestId) return byTestId;

        // Fallback по домену
        return modal.querySelector(
            'img[src*="avatars.yandex.net"], img[src*="avatars.mds.yandex.net"], img[src*="music.yandex"]'
        ) || null;
    }

    // Уникальный ID трека из ссылки на трек
    function getTrackId(modal) {
        const link = modal.querySelector('a[data-test-id="TRACK_TITLE"]');
        if (link) {
            const m = link.getAttribute('href').match(/trackId=(\d+)/);
            if (m) return m[1];
        }
        // Fallback: текст названия как псевдо-ID
        const titleEl = modal.querySelector('[data-test-id="TRACK_TITLE"]');
        return titleEl ? titleEl.textContent.trim() : null;
    }

    // Информация о треке
    function getTrackInfo(modal) {
        const titleEl = modal.querySelector('[data-test-id="TRACK_TITLE"]');
        const artistEl = modal.querySelector('[data-test-id="SEPARATED_ARTIST_TITLE"]');

        const title = titleEl ? titleEl.textContent.trim() : 'Unknown';
        const artist = artistEl ? artistEl.textContent.trim() : 'Unknown';

        // Версия трека (SLOWED, Remix и т.п.)
        const versionEl = modal.querySelector('[data-test-id="TRACK_VERSION"]');
        const version = versionEl ? versionEl.textContent.trim() : '';

        return { title: title + (version ? ' ' + version : ''), artist };
    }

    // URL обложки с нужным размером
    function buildCoverUrl(img) {
        let url = img.src || (img.srcset && img.srcset.split(',')[0].trim().split(' ')[0]);
        if (!url) return null;

        let size = 'orig';
        if (settings?.imageQuality) {
            const q = settings.imageQuality.value;
            if (q === 1) size = '200x200';
            else if (q === 2) size = '400x400';
            else if (q === 3) size = '1000x1000';
            else size = 'orig';
        }

        return size === 'orig'
            ? url.replace(/\/\d+x\d+/, '/orig')
            : url.replace(/\/\d+x\d+/, `/${size}`);
    }

    // ─── Кнопка ───────────────────────────────────────────────────────────────

    function createDownloadButton() {
        const button = document.createElement('button');
        button.className = 'cover-download-button';
        button.setAttribute('aria-label', 'Скачать обложку');
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

    function addDownloadButton() {
        if (isDownloading || isUpdating) return;
        isUpdating = true;

        try {
            const modal = getModal();

            if (!modal) {
                removeButton();
                return;
            }

            const trackId = getTrackId(modal);

            // Кнопка уже на месте и трек не изменился
            if (trackId && trackId === lastTrackId &&
                downloadButton && downloadButton.isConnected) {
                return;
            }

            lastTrackId = trackId;

            const coverImg = getCoverImage(modal);
            if (!coverImg) return;

            // Ждём загрузки изображения
            if (!coverImg.complete || coverImg.naturalHeight === 0) {
                isUpdating = false;
                coverImg.addEventListener('load', () => addDownloadButton(), { once: true });
                // Страховка: если load не стрельнул (кеш, race condition) — повторяем через 300мс
                setTimeout(() => {
                    if (!downloadButton || !downloadButton.isConnected) {
                        addDownloadButton();
                    }
                }, 300);
                return;
            }

            const container = getPosterContainer(modal) || coverImg.parentElement;
            if (!container) return;

            // Контейнер не изменился и кнопка на месте
            if (container === currentContainer && downloadButton && downloadButton.isConnected) {
                return;
            }

            removeButton();

            currentCoverUrl = buildCoverUrl(coverImg);
            if (!currentCoverUrl) return;

            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }

            container.classList.add('cover-download-button-container');

            downloadButton = createDownloadButton();
            container.appendChild(downloadButton);
            currentContainer = container;

            applyWin2kStyle(isWindows2000Active());

            console.log('[CoverDownloader] кнопка добавлена');
        } finally {
            isUpdating = false;
        }
    }

    function removeButton() {
        if (downloadButton && downloadButton.parentNode) {
            downloadButton.parentNode.removeChild(downloadButton);
        }
        downloadButton = null;
        currentContainer = null;
        currentCoverUrl = null;
        lastTrackId = null;
    }

    // ─── Скачивание ───────────────────────────────────────────────────────────

    async function downloadCover() {
        if (!currentCoverUrl || isDownloading) return;

        try {
            isDownloading = true;

            const modal = getModal();
            const trackInfo = modal ? getTrackInfo(modal) : null;

            let filename = 'cover.jpg';
            if (trackInfo && trackInfo.artist !== 'Unknown' && trackInfo.title !== 'Unknown') {
                if (settings?.fileNameFormat?.fileNamePattern) {
                    filename = settings.fileNameFormat.fileNamePattern.value
                        .replace('{artist}', trackInfo.artist)
                        .replace('{title}', trackInfo.title) + '.jpg';
                } else {
                    filename = `${trackInfo.artist} - ${trackInfo.title}.jpg`;
                }
                filename = filename.replace(/[/\\?%*:|"<>]/g, '-');
            }

            const response = await fetch(currentCoverUrl);
            const blob = await response.blob();

            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: [{ description: 'Изображения', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }]
                    });
                    const writable = await handle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    if (settings?.showNotifications?.value) showNotification('Обложка сохранена', filename);
                } catch (err) {
                    if (err.name !== 'AbortError') console.error('[CoverDownloader] сохранение:', err);
                }
            } else {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                URL.revokeObjectURL(url);
                document.body.removeChild(a);
                if (settings?.showNotifications?.value) showNotification('Обложка скачана', filename);
            }
        } catch (error) {
            console.error('[CoverDownloader] downloadCover:', error);
        } finally {
            isDownloading = false;
        }
    }

    function showNotification(title, message) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body: message, icon: currentCoverUrl });
        }
    }

    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    // ─── Windows 2000 тема ────────────────────────────────────────────────────

    function isWindows2000Active() {
        return getComputedStyle(document.documentElement)
            .getPropertyValue('--ym-radius-size-round').trim() === '0';
    }

    function applyWin2kStyle(active) {
        if (!downloadButton) return;
        downloadButton.classList.toggle('win2k-style', active);
    }

    // ─── MutationObserver ─────────────────────────────────────────────────────

    let updateTimeout = null;

    // Быстрая проверка: появился ли постер или изображение обложки
    function isRelevantMutation(mutations) {
        for (const mutation of mutations) {
            // Игнорируем изменения внутри самой кнопки
            let node = mutation.target;
            let inside = false;
            while (node && node !== document.body) {
                if (node.classList?.contains('cover-download-button') ||
                    node.classList?.contains('cover-download-button-container')) {
                    inside = true;
                    break;
                }
                node = node.parentNode;
            }
            if (inside) continue;

            for (const n of [...mutation.addedNodes, ...mutation.removedNodes]) {
                if (n.nodeType !== 1) continue;
                if (n.classList?.contains('cover-download-button')) continue;

                // Высокий приоритет: появился постер или модальное окно плеера
                const testId = n.dataset?.testId || '';
                if (
                    testId === 'FULLSCREEN_PLAYER_POSTER_CONTENT' ||
                    testId === 'FULLSCREEN_PLAYER_MODAL' ||
                    testId === 'ENTITY_COVER_IMAGE' ||
                    n.querySelector?.('[data-test-id="FULLSCREEN_PLAYER_POSTER_CONTENT"]') ||
                    n.querySelector?.('[data-test-id="ENTITY_COVER_IMAGE"]')
                ) {
                    return 'immediate';
                }

                return 'debounce';
            }
        }
        return null;
    }

    const observer = new MutationObserver((mutations) => {
        if (isDownloading || isUpdating) return;

        const priority = isRelevantMutation(mutations);
        if (!priority) return;

        clearTimeout(updateTimeout);

        if (priority === 'immediate') {
            // Постер появился — добавляем кнопку без задержки
            updateTimeout = setTimeout(addDownloadButton, 0);
        } else {
            updateTimeout = setTimeout(addDownloadButton, 100);
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // ─── Периодическая проверка ───────────────────────────────────────────────

    setInterval(async () => {
        settings = await getSettings("CoverDownloader");
        applyWin2kStyle(isWindows2000Active());

        const modal = getModal();
        if (modal && (!downloadButton || !downloadButton.isConnected)) {
            lastTrackId = null; // форсируем пересоздание
            addDownloadButton();
        }

        // Автоскачивание
        if (settings?.autoDownload?.value && modal) {
            const trackId = getTrackId(modal);
            if (trackId && trackId !== lastTrackId) {
                currentCoverUrl = buildCoverUrl(getCoverImage(modal));
                if (currentCoverUrl) await downloadCover();
            }
        }
    }, 1000);

    console.log('[CoverDownloader] аддон загружен');
})();
