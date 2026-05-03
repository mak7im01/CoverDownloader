// Аддон для скачивания обложек треков в PulseSync
// Кнопка на обложке в полноэкранном плеере + кнопка рядом с названием трека

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
                            value: item.bool ?? item.input ?? item.selected ?? item.value ?? item.filePath,
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
        const byTestId = modal.querySelector('img[data-test-id="ENTITY_COVER_IMAGE"]');
        if (byTestId) return byTestId;

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
        const titleEl = modal.querySelector('[data-test-id="TRACK_TITLE"]');
        return titleEl ? titleEl.textContent.trim() : null;
    }

    // Информация о треке
    function getTrackInfo(modal) {
        const titleEl = modal.querySelector('[data-test-id="TRACK_TITLE"]');
        const artistEl = modal.querySelector('[data-test-id="SEPARATED_ARTIST_TITLE"]');

        const title = titleEl ? titleEl.textContent.trim() : 'Unknown';
        const artist = artistEl ? artistEl.textContent.trim() : 'Unknown';

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

    // URL обложки из контейнера метаданных (для inline-кнопки)
    function getCoverUrlFromMeta(metaContainer) {
        // Приоритет: полноэкранный плеер
        const modal = document.querySelector('div[data-test-id="FULLSCREEN_PLAYER_MODAL"]');
        let img = null;

        if (modal) {
            img = modal.querySelector('img[data-test-id="ENTITY_COVER_IMAGE"]') ||
                  modal.querySelector('img[src*="avatars.yandex.net"], img[src*="music.yandex"]');
        }

        // Fallback: ищем обложку в playerbar рядом с метаданными
        if (!img) {
            const playerbar = metaContainer.closest('.PlayerBarDesktopWithBackgroundProgressBar_infoCard__i0cbW') ||
                              metaContainer.closest('[data-test-id="PLAYERBAR_DESKTOP_COVER_CONTAINER"]')?.parentElement ||
                              document.querySelector('[data-test-id="PLAYERBAR_DESKTOP_COVER_CONTAINER"]');
            if (playerbar) {
                img = playerbar.querySelector('img[data-test-id="ENTITY_COVER_IMAGE"]') ||
                      playerbar.querySelector('img[src*="avatars.yandex.net"], img[src*="music.yandex"]');
            }
        }

        // Последний fallback: любая обложка на странице
        if (!img) {
            img = document.querySelector('img[src*="avatars.yandex.net"], img[src*="music.yandex"]');
        }

        if (!img?.src) return null;

        let url = img.src;
        const quality = settings?.imageQuality?.value;
        let size = '1000x1000';
        if (quality === 1) size = '200x200';
        else if (quality === 2) size = '400x400';
        else if (quality === 3) size = '1000x1000';
        else if (quality === 4) size = 'orig';

        return size === 'orig'
            ? url.replace(/\/\d+x\d+/, '/orig')
            : url.replace(/\/\d+x\d+/, `/${size}`);
    }

    // Имя файла из контейнера метаданных
    function getFilenameFromMeta(metaContainer) {
        const titleEl   = metaContainer.querySelector('[data-test-id="TRACK_TITLE"] .Meta_title__GGBnH');
        const artistEls = metaContainer.querySelectorAll('[data-test-id="SEPARATED_ARTIST_TITLE"] .Meta_artistCaption__JESZi');

        const title  = titleEl?.textContent.trim() || 'Unknown';
        const artist = artistEls.length
            ? Array.from(artistEls).map(el => el.textContent.trim()).join(', ')
            : 'Unknown';

        const pattern = settings?.fileNameFormat?.fileNamePattern?.value || '{artist} - {title}';
        const name = pattern.replace('{artist}', artist).replace('{title}', title);
        return name.replace(/[/\\?%*:|"<>]/g, '-') + '.jpg';
    }

    // ─── Полноэкранная кнопка ─────────────────────────────────────────────────

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
        // Если полноэкранная кнопка отключена в настройках
        if (settings?.fullscreenEnabled?.value === false) {
            removeButton();
            return;
        }
        isUpdating = true;

        try {
            const modal = getModal();

            if (!modal) {
                removeButton();
                return;
            }

            const trackId = getTrackId(modal);

            if (trackId && trackId === lastTrackId &&
                downloadButton && downloadButton.isConnected) {
                return;
            }

            lastTrackId = trackId;

            const coverImg = getCoverImage(modal);
            if (!coverImg) return;

            if (!coverImg.complete || coverImg.naturalHeight === 0) {
                isUpdating = false;
                coverImg.addEventListener('load', () => addDownloadButton(), { once: true });
                setTimeout(() => {
                    if (!downloadButton || !downloadButton.isConnected) {
                        addDownloadButton();
                    }
                }, 300);
                return;
            }

            const container = getPosterContainer(modal) || coverImg.parentElement;
            if (!container) return;

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

    // ─── Inline-кнопка рядом с названием трека ────────────────────────────────

    function createInlineIcon() {
        const size    = Number(settings?.iconSize?.value)    || 18;
        const opacity = (Number(settings?.iconOpacity?.value) || 70) / 100;

        const btn = document.createElement('button');
        btn.className = 'cd-inline-icon';
        btn.title = 'Скачать обложку';
        btn.innerHTML = `
            <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/>
            </svg>
        `;
        btn.style.cssText = `
            background: transparent; border: none; cursor: pointer;
            padding: 4px; display: inline-flex; align-items: center;
            justify-content: center; opacity: ${opacity};
            transition: opacity 0.2s, color 0.2s; margin-left: 8px;
            vertical-align: middle;
            color: var(--ym-controls-color-primary-text-enabled_variant, #ffffff);
        `;

        btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
        btn.addEventListener('mouseleave', () => { btn.style.opacity = String(opacity); });

        return btn;
    }

    function addInlineIconToMeta(metaContainer) {
        const titleContainer = metaContainer.querySelector('.Meta_titleContainer__gDuXr');
        if (!titleContainer) return;

        const copyIcon = titleContainer.querySelector('.copy-track-icon');
        const existing = metaContainer.querySelector('.cd-inline-icon');

        // Если иконка уже есть — проверяем не появился ли copyIcon после неё
        if (existing) {
            if (copyIcon) {
                // copyIcon есть — проверяем правильность позиции
                const position = Number(settings?.iconPosition?.value ?? 1);
                const nodes = Array.from(titleContainer.childNodes);
                const existingIdx = nodes.indexOf(existing);
                const copyIdx = nodes.indexOf(copyIcon);
                const positionCorrect = position === 2
                    ? existingIdx < copyIdx   // слева: наша иконка должна быть перед copy
                    : existingIdx > copyIdx;  // справа: наша иконка должна быть после copy
                if (positionCorrect) return;
                // Позиция неправильная — удаляем и пересоздаём
                existing.remove();
            } else {
                return;
            }
        }

        const btn = createInlineIcon();
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (btn.disabled) return;
            btn.disabled = true;
            btn.style.opacity = '0.3';

            try {
                await downloadCoverFromMeta(metaContainer);
            } finally {
                btn.disabled = false;
                const opacity = (Number(settings?.iconOpacity?.value) || 70) / 100;
                btn.style.opacity = String(opacity);
            }
        });

        if (copyIcon) {
            const position = Number(settings?.iconPosition?.value ?? 1);
            if (position === 2) {
                copyIcon.insertAdjacentElement('beforebegin', btn);
            } else {
                copyIcon.insertAdjacentElement('afterend', btn);
            }
        } else {
            titleContainer.appendChild(btn);
        }
    }

    function processAllMeta() {
        if (settings?.inlineEnabled?.value === false) return;
        document.querySelectorAll('.Meta_root__R8n1h').forEach(addInlineIconToMeta);
    }

    function refreshInlineIcons() {
        document.querySelectorAll('.cd-inline-icon').forEach(el => el.remove());
        processAllMeta();
    }

    // ─── Скачивание (полноэкранный режим) ─────────────────────────────────────

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

            await saveFile(currentCoverUrl, filename);
        } catch (error) {
            console.error('[CoverDownloader] downloadCover:', error);
            showToast('Ошибка скачивания', false);
        } finally {
            isDownloading = false;
        }
    }

    // ─── Скачивание (inline) ──────────────────────────────────────────────────

    async function downloadCoverFromMeta(metaContainer) {
        const coverUrl = getCoverUrlFromMeta(metaContainer);
        if (!coverUrl) {
            showToast('Обложка не найдена', false);
            return;
        }

        try {
            const filename = getFilenameFromMeta(metaContainer);
            await saveFile(coverUrl, filename);
        } catch (err) {
            console.error('[CoverDownloader] downloadCoverFromMeta:', err);
            showToast('Ошибка скачивания', false);
        }
    }

    // ─── Общая логика сохранения файла ───────────────────────────────────────

    async function saveFile(url, filename) {
        if (window.showSaveFilePicker) {
            // Показываем диалог СРАЗУ в контексте user gesture, до fetch
            let writable;
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{ description: 'Изображения', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }]
                });
                writable = await handle.createWritable();
            } catch (err) {
                if (err.name === 'AbortError') return;
                throw err;
            }
            // Теперь качаем и пишем
            const blob = await fetch(url).then(r => r.blob());
            await writable.write(blob);
            await writable.close();
        } else {
            const blob = await fetch(url).then(r => r.blob());
            const objUrl = URL.createObjectURL(blob);
            const a = Object.assign(document.createElement('a'), { href: objUrl, download: filename });
            document.body.appendChild(a);
            a.click();
            URL.revokeObjectURL(objUrl);
            a.remove();
        }

        if (settings?.showNotifications?.value !== false) {
            showToast('Обложка сохранена: ' + filename, true);
        }
    }

    // ─── Toast-уведомление ────────────────────────────────────────────────────

    function showToast(message, success = true) {
        const el = document.createElement('div');
        el.textContent = message;
        el.style.cssText = `
            position: fixed; bottom: 20px; right: 20px;
            background: ${success ? '#4CAF50' : '#f44336'};
            color: white; padding: 12px 24px; border-radius: 4px;
            z-index: 10000; font-size: 14px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            animation: cd-slideIn 0.3s ease-out;
        `;
        document.body.appendChild(el);
        setTimeout(() => {
            el.style.animation = 'cd-slideOut 0.3s ease-out';
            setTimeout(() => el.remove(), 300);
        }, 2000);
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

    // ─── Стили анимации ───────────────────────────────────────────────────────

    const style = document.createElement('style');
    style.textContent = `
        @keyframes cd-slideIn {
            from { transform: translateX(400px); opacity: 0; }
            to   { transform: translateX(0);     opacity: 1; }
        }
        @keyframes cd-slideOut {
            from { transform: translateX(0);     opacity: 1; }
            to   { transform: translateX(400px); opacity: 0; }
        }
    `;
    document.head.appendChild(style);

    // ─── MutationObserver ─────────────────────────────────────────────────────

    let updateTimeout = null;

    function isRelevantMutation(mutations) {
        for (const mutation of mutations) {
            let node = mutation.target;
            let inside = false;
            while (node && node !== document.body) {
                if (node.classList?.contains('cover-download-button') ||
                    node.classList?.contains('cover-download-button-container') ||
                    node.classList?.contains('cd-inline-icon')) {
                    inside = true;
                    break;
                }
                node = node.parentNode;
            }
            if (inside) continue;

            for (const n of [...mutation.addedNodes, ...mutation.removedNodes]) {
                if (n.nodeType !== 1) continue;
                if (n.classList?.contains('cover-download-button')) continue;
                if (n.classList?.contains('cd-inline-icon')) continue;

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

    // Observer для inline-иконок — запускается только после загрузки настроек
    const inlineObserver = new MutationObserver(() => processAllMeta());

    // Observer для полноэкранной кнопки — с фильтрацией
    const observer = new MutationObserver((mutations) => {
        if (isDownloading || isUpdating) return;

        const priority = isRelevantMutation(mutations);
        if (!priority) return;

        clearTimeout(updateTimeout);
        if (priority === 'immediate') {
            updateTimeout = setTimeout(addDownloadButton, 0);
        } else {
            updateTimeout = setTimeout(addDownloadButton, 100);
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // ─── Периодическая проверка ───────────────────────────────────────────────

    let lastIconPosition = null;
    let lastIconSize = null;
    let lastIconOpacity = null;
    let lastInlineEnabled = null;
    let lastFullscreenEnabled = null;

    setInterval(async () => {
        const newSettings = await getSettings("CoverDownloader");
        if (newSettings) {
            const newPosition         = Number(newSettings?.iconPosition?.value ?? 1);
            const newSize             = Number(newSettings?.iconSize?.value     ?? 18);
            const newOpacity          = Number(newSettings?.iconOpacity?.value  ?? 70);
            const newInlineEnabled    = newSettings?.inlineEnabled?.value !== false;
            const newFullscreenEnabled = newSettings?.fullscreenEnabled?.value !== false;

            const visualChanged =
                (lastIconPosition      !== null && lastIconPosition      !== newPosition)         ||
                (lastIconSize          !== null && lastIconSize          !== newSize)              ||
                (lastIconOpacity       !== null && lastIconOpacity       !== newOpacity)           ||
                (lastInlineEnabled     !== null && lastInlineEnabled     !== newInlineEnabled)     ||
                lastIconPosition === null;

            // Если полноэкранная кнопка была включена/выключена
            if (lastFullscreenEnabled !== null && lastFullscreenEnabled !== newFullscreenEnabled) {
                if (!newFullscreenEnabled) {
                    removeButton();
                } else {
                    lastTrackId = null; // форсируем пересоздание
                }
            }

            lastIconPosition       = newPosition;
            lastIconSize           = newSize;
            lastIconOpacity        = newOpacity;
            lastInlineEnabled      = newInlineEnabled;
            lastFullscreenEnabled  = newFullscreenEnabled;

            settings = newSettings;

            if (visualChanged) {
                document.querySelectorAll('.cd-inline-icon').forEach(el => el.remove());
                processAllMeta();
            }
        }
        applyWin2kStyle(isWindows2000Active());

        // Страховка: добавляем иконки если их нет
        processAllMeta();

        const modal = getModal();
        if (modal && (!downloadButton || !downloadButton.isConnected)) {
            lastTrackId = null;
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

    // Первичная инициализация — сначала загружаем настройки, потом запускаем observer и создаём иконки
    getSettings("CoverDownloader").then(s => {
        if (s) settings = s;
        inlineObserver.observe(document.body, { childList: true, subtree: true });
        processAllMeta();
    });

    console.log('[CoverDownloader] аддон загружен');
})();
