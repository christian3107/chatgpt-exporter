// ==UserScript==
// @name         ChatGPT Exporter
// @namespace    chatgpt-web-conversation-json-exporter
// @version      2.1.1
// @description  Exports the current regular ChatGPT conversation as enriched raw JSON.
// @match        https://chatgpt.com/*
// @downloadURL  https://raw.githubusercontent.com/christian3107/chatgpt-exporter/main/ChatGPT%20Exporter.user.js
// @updateURL    https://raw.githubusercontent.com/christian3107/chatgpt-exporter/main/ChatGPT%20Exporter.user.js
// @icon         https://icons.duckduckgo.com/ip3/chatgpt.com.ico
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    // CONFIGURATION
    // ============================================================

    const EXPORTER_VERSION = '2.1.1';
    const EXPORT_BUTTON_ID = 'chatgpt-json-export-9f7c2e41';

    const HEADER_BUTTONS_SELECTOR =
        '[data-app-shell-main-titlebar="true"] ' +
        '[data-app-shell-header-obstacle="true"] button';

    const UUID_PATTERN =
        '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

    const CONVERSATION_PATH_RE = new RegExp(
        `/c/(${UUID_PATTERN})(?=/|$)`,
        'i'
    );

    const SHARED_PATH_RE = new RegExp(
        `^/share/${UUID_PATTERN}(?=/|$)`,
        'i'
    );

    const EN_US_LABELS = Object.freeze({
        locale: 'en-US',
        share: 'Share',
        export: 'Export'
    });

    // Fallbacks lexicaux uniquement pour le libellé du bouton Export.
    const EXPORT_LABEL_KEYS = [
        'settings.chatGpt.dataControls.export.button',
        'common.save',
        'settings.chatGpt.account.save',
        'settings.chatGpt.personalization.save'
    ];

    const state = {
        accessToken: null,
        isExporting: false,
        uiObserver: null,
        pendingUiCheck: false,
        keepAliveTimer: null,
        labels: null,
        debug: false
    };

    let localizationLocale = null;
    let localizationPromise = null;

    // ============================================================
    // ICONS / STYLE
    // ============================================================

    const EXPORT_ICON = `
        <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16"
             xmlns="http://www.w3.org/2000/svg">
            <path d="M13.3337 8.14162C13.6235 8.14179 13.8582 8.37716 13.8582 8.66701V11.2002C13.8582 12.6684 12.6681 13.8584 11.2 13.8584H4.80054C3.33238 13.8584 2.14136 12.6684 2.14136 11.2002V8.66701C2.14136 8.37706 2.3768 8.14162 2.66675 8.14162C2.9567 8.14162 3.19214 8.37706 3.19214 8.66701V11.2002C3.19214 12.0885 3.91228 12.8086 4.80054 12.8086H11.2C12.0882 12.8086 12.8083 12.0885 12.8083 11.2002V8.66701C12.8083 8.37706 13.0438 8.14162 13.3337 8.14162Z"
                  fill="currentColor"></path>
            <g transform="translate(0, 12) scale(1, -1)">
                <path d="M7.45874 2.47267C7.77339 2.21619 8.22716 2.21609 8.54175 2.47267L8.60718 2.53126L11.2048 5.12892C11.4097 5.33383 11.4095 5.66606 11.2048 5.87111C10.9998 6.07613 10.6677 6.07613 10.4626 5.87111L8.52515 3.93361V9.50001C8.52515 9.78996 8.28971 10.0254 7.99976 10.0254C7.70996 10.0252 7.47437 9.78986 7.47437 9.50001V3.93361L5.53784 5.87111C5.33282 6.07613 5.00068 6.07613 4.79565 5.87111C4.5908 5.66607 4.59069 5.33389 4.79565 5.12892L7.39331 2.53126L7.45874 2.47267Z"
                      fill="currentColor"></path>
            </g>
        </svg>`;

    const SPINNER = `
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2"
             style="animation:chatgpt-json-export-spin 1s linear infinite;">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
        </svg>`;

    function injectStyles() {
        GM_addStyle(`
            @keyframes chatgpt-json-export-spin {
                100% { transform: rotate(360deg); }
            }

            #${EXPORT_BUTTON_ID} svg {
                width: 16px;
                height: 16px;
                flex-shrink: 0;
            }
        `);
    }

    // ============================================================
    // CONVERSATION / ROUTE
    // ============================================================

    function getConversationUuid() {
        return window.location.pathname.match(CONVERSATION_PATH_RE)?.[1] || null;
    }

    function isTemporaryChat() {
        return new URLSearchParams(window.location.search)
            .get('temporary-chat') === 'true';
    }

    function isSharedChat() {
        return SHARED_PATH_RE.test(window.location.pathname);
    }

    function isRegularChat() {
        return !!getConversationUuid() &&
            !isTemporaryChat() &&
            !isSharedChat();
    }

    function debugLog(...args) {
        if (state.debug) {
            console.debug('[ChatGPT JSON Exporter]', ...args);
        }
    }

    // ============================================================
    // LOCALIZATION
    // ============================================================

    function getPageLocale() {
        return document.documentElement.lang?.trim() || 'en-US';
    }

    function getNonEmptyString(value) {
        if (typeof value !== 'string') return null;

        const trimmed = value.trim();
        return trimmed || null;
    }

    function findLocalePreload(locale) {
        const links = document.querySelectorAll(
            'link[rel="preload"][as="fetch"][href]'
        );

        for (const link of links) {
            const href = link.getAttribute('href');
            if (!href) continue;

            let pathname;

            try {
                pathname = new URL(
                    href,
                    window.location.href
                ).pathname;
            } catch {
                continue;
            }

            const filename = pathname.split('/').pop();

            if (
                filename?.startsWith(`${locale}.`) &&
                filename.endsWith('.json')
            ) {
                return link;
            }
        }

        return null;
    }

    async function loadLocalizedLabels(locale) {
        if (locale.toLowerCase() === 'en-us') {
            return EN_US_LABELS;
        }

        const preload = findLocalePreload(locale);

        if (!preload) {
            debugLog(
                'Localization preload not found:',
                locale
            );
            return null;
        }

        try {
            const response = await fetch(preload.href);

            if (!response.ok) {
                debugLog(
                    'Localization fetch failed:',
                    response.status
                );
                return null;
            }

            const translations = await response.json();

            const share = getNonEmptyString(
                translations['chatgptConversations.share']
            );

            if (!share) {
                debugLog(
                    'Share translation not found:',
                    locale
                );
                return null;
            }

            let exportLabel = null;

            for (const key of EXPORT_LABEL_KEYS) {
                exportLabel = getNonEmptyString(
                    translations[key]
                );

                if (exportLabel) break;
            }

            if (!exportLabel) {
                debugLog(
                    'Export/Save translation not found:',
                    locale
                );
                return null;
            }

            return {
                locale,
                share,
                export: exportLabel
            };

        } catch (error) {
            debugLog(
                'Localization load failed:',
                error
            );
            return null;
        }
    }

    function getLocalizedLabels() {
        const locale = getPageLocale();

        if (
            localizationPromise &&
            localizationLocale === locale
        ) {
            return localizationPromise;
        }

        localizationLocale = locale;
        localizationPromise =
            loadLocalizedLabels(locale);

        return localizationPromise;
    }

    // ============================================================
    // SHARE / EXPORT BUTTON
    // ============================================================

    function getShareButton(shareLabel) {
        if (!shareLabel) {
            return null;
        }

        const matches = [
            ...document.querySelectorAll(
                HEADER_BUTTONS_SELECTOR
            )
        ].filter(button => {
            const ariaLabel =
                button.getAttribute('aria-label')
                    ?.trim();

            return (
                ariaLabel === shareLabel &&
                !button.hasAttribute('aria-haspopup')
            );
        });

        // En cas d'ambiguïté, on échoue volontairement.
        return matches.length === 1
            ? matches[0]
            : null;
    }

    function setButtonContent(
        button,
        iconHtml,
        label
    ) {
        button.innerHTML = iconHtml;
        button.append(
            document.createTextNode(label)
        );
    }

    function syncButtonAvailability() {
        if (state.isExporting) {
            return;
        }

        const exportButton =
            document.getElementById(
                EXPORT_BUTTON_ID
            );

        if (
            !exportButton ||
            !state.labels
        ) {
            return;
        }

        const shareButton =
            getShareButton(
                state.labels.share
            );

        if (!shareButton) {
            return;
        }

        if (
            exportButton.disabled !==
            shareButton.disabled
        ) {
            exportButton.disabled =
                shareButton.disabled;
        }
    }

    function setButtonVisualState(
        mode = 'idle'
    ) {
        const button =
            document.getElementById(
                EXPORT_BUTTON_ID
            );

        if (
            !button ||
            !state.labels
        ) {
            return;
        }

        if (mode === 'loading') {
            setButtonContent(
                button,
                SPINNER,
                state.labels.export
            );

            button.disabled = true;

            button.setAttribute(
                'aria-busy',
                'true'
            );

            return;
        }

        setButtonContent(
            button,
            EXPORT_ICON,
            state.labels.export
        );

        button.removeAttribute(
            'aria-busy'
        );

        syncButtonAvailability();
    }

    function createExportButton(
        shareButton,
        exportLabel
    ) {
        const button =
            document.createElement(
                'button'
            );

        button.id =
            EXPORT_BUTTON_ID;

        button.type =
            'button';

        button.className =
            shareButton.className;

        button.setAttribute(
            'aria-label',
            exportLabel
        );

        setButtonContent(
            button,
            EXPORT_ICON,
            exportLabel
        );

        button.addEventListener(
            'click',
            event => {
                event.stopPropagation();
                exportCurrentConversation();
            }
        );

        return button;
    }

    async function ensureButtonMounted() {
        if (!isRegularChat()) {
            return false;
        }

        if (
            document.getElementById(
                EXPORT_BUTTON_ID
            )
        ) {
            return true;
        }

        const labels =
            await getLocalizedLabels();

        if (!labels) {
            return false;
        }

        // Le chargement de la localisation est asynchrone :
        // le contexte peut avoir changé pendant le fetch.
        if (
            !isRegularChat() ||
            getPageLocale() !== labels.locale ||
            document.getElementById(
                EXPORT_BUTTON_ID
            )
        ) {
            return false;
        }

        const shareButton =
            getShareButton(
                labels.share
            );

        if (!shareButton) {
            return false;
        }

        state.labels = labels;

        const exportButton =
            createExportButton(
                shareButton,
                labels.export
            );

        shareButton.insertAdjacentElement(
            'afterend',
            exportButton
        );

        syncButtonAvailability();

        debugLog(
            'Export button inserted'
        );

        return true;
    }

    // ============================================================
    // AUTH / CONVERSATION FETCH
    // ============================================================

    async function ensureAccessToken() {
        if (state.accessToken) {
            return state.accessToken;
        }

        const response =
            await fetch(
                '/api/auth/session'
            );

        const data =
            await response.json();

        if (!data?.accessToken) {
            throw new Error(
                'Missing access token'
            );
        }

        state.accessToken =
            data.accessToken;

        return state.accessToken;
    }

    async function fetchConversationData(uuid) {
        const accessToken =
            await ensureAccessToken();

        const response = await fetch(
            `/backend-api/conversation/${uuid}`,
            {
                headers: {
                    Authorization:
                        `Bearer ${accessToken}`
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                `Conversation fetch failed: ${response.status}`
            );
        }

        return response.json();
    }

    // ============================================================
    // JSON GENERATION
    // ============================================================

    function toIsoTimestamp(value) {
        if (
            typeof value !== 'number' ||
            !Number.isFinite(value)
        ) {
            return null;
        }

        return new Date(
            value * 1000
        ).toISOString();
    }

    function processData(data) {
        if (
            !data?.mapping ||
            !data?.current_node
        ) {
            return [];
        }

        const thread = [];
        let currId =
            data.current_node;

        while (currId) {
            const node =
                data.mapping[currId];

            if (!node) break;

            const msg =
                node.message;

            if (
                msg &&
                msg.content &&
                Array.isArray(
                    msg.content.parts
                ) &&
                msg.content.parts.length > 0
            ) {
                const parts =
                    msg.content.parts
                        .map(part =>
                            typeof part === 'string'
                                ? part
                                : '```\nCode Block\n```'
                        )
                        .filter(part =>
                            typeof part === 'string' &&
                            part.trim().length > 0
                        );

                const text =
                    parts
                        .join('\n\n')
                        .trim();

                if (text) {
                    thread.push({
                        id: currId,
                        role:
                            msg.author?.role ||
                            'unknown',
                        timestamp:
                            toIsoTimestamp(
                                msg.create_time
                            ),
                        text
                    });
                }
            }

            currId =
                node.parent;
        }

        return thread.reverse();
    }

    function buildExportPayload(
        conversationId,
        title,
        messages
    ) {
        const rolesPresent = [
            ...new Set(
                messages
                    .map(m => m.role)
                    .filter(Boolean)
            )
        ];

        const timestamps =
            messages
                .map(m => m.timestamp)
                .filter(
                    ts =>
                        typeof ts === 'string'
                )
                .sort();

        return {
            meta: {
                title,
                conversation_id:
                    conversationId,
                exported_at:
                    new Date().toISOString(),
                exporter_version:
                    EXPORTER_VERSION,
                source:
                    'chatgpt.com',
                message_count:
                    messages.length,
                roles_present:
                    rolesPresent,
                created_at_min:
                    timestamps.length
                        ? timestamps[0]
                        : null,
                created_at_max:
                    timestamps.length
                        ? timestamps[
                            timestamps.length - 1
                        ]
                        : null
            },
            messages
        };
    }

    function getFilename(title) {
        const date =
            new Date()
                .toISOString()
                .slice(0, 10);

        const safeTitle =
            (title || 'ChatGPT Export')
                .replace(
                    /[/\\?%*:|"<>]/g,
                    '-'
                )
                .substring(0, 50);

        return `${safeTitle} - ${date}.json`;
    }

    function triggerDownload(
        content,
        type,
        filename
    ) {
        const blob =
            new Blob(
                [content],
                { type }
            );

        const url =
            URL.createObjectURL(blob);

        const anchor =
            document.createElement('a');

        anchor.href = url;
        anchor.download = filename;

        anchor.click();

        setTimeout(
            () =>
                URL.revokeObjectURL(url),
            1000
        );
    }

    async function exportCurrentConversation() {
        if (
            state.isExporting ||
            !isRegularChat() ||
            !state.labels
        ) {
            return;
        }

        const shareButton =
            getShareButton(
                state.labels.share
            );

        // Pas de fallback :
        // si Share n'est plus identifiable ou est désactivé,
        // l'export ne démarre pas.
        if (
            !shareButton ||
            shareButton.disabled
        ) {
            return;
        }

        const uuid =
            getConversationUuid();

        if (!uuid) {
            return;
        }

        state.isExporting = true;

        setButtonVisualState(
            'loading'
        );

        try {
            const data =
                await fetchConversationData(
                    uuid
                );

            const title =
                data.title ||
                document.title ||
                'ChatGPT Export';

            const messages =
                processData(data);

            const payload =
                buildExportPayload(
                    uuid,
                    title,
                    messages
                );

            triggerDownload(
                JSON.stringify(
                    payload,
                    null,
                    2
                ),
                'application/json',
                getFilename(title)
            );

        } catch (error) {
            console.error(
                'JSON export failed',
                error
            );

        } finally {
            state.isExporting = false;

            setButtonVisualState(
                'idle'
            );
        }
    }

    // ============================================================
    // UI CHECK / SPA NAVIGATION
    // ============================================================

    async function runUiCheck() {
        state.pendingUiCheck =
            false;

        const exportButton =
            document.getElementById(
                EXPORT_BUTTON_ID
            );

        if (!isRegularChat()) {
            exportButton?.remove();
            return;
        }

        if (!exportButton) {
            await ensureButtonMounted();
        }

        syncButtonAvailability();
    }

    function scheduleUiCheck() {
        if (state.pendingUiCheck) {
            return;
        }

        state.pendingUiCheck =
            true;

        requestAnimationFrame(
            () => {
                void runUiCheck();
            }
        );
    }

    function stopKeepAlive() {
        if (!state.keepAliveTimer) {
            return;
        }

        clearTimeout(
            state.keepAliveTimer
        );

        state.keepAliveTimer =
            null;
    }

    function startKeepAliveWindow(
        durationMs = 8000
    ) {
        stopKeepAlive();

        const deadline =
            Date.now() + durationMs;

        const tick = () => {
            scheduleUiCheck();

            if (
                Date.now() < deadline
            ) {
                state.keepAliveTimer =
                    setTimeout(
                        tick,
                        250
                    );
            } else {
                state.keepAliveTimer =
                    null;

                debugLog(
                    'Keep-alive window ended'
                );
            }
        };

        tick();
    }

    function startUiObserver() {
        if (state.uiObserver) {
            return;
        }

        state.uiObserver =
            new MutationObserver(
                mutations => {
                    const exportButton =
                        document.getElementById(
                            EXPORT_BUTTON_ID
                        );

                    if (!isRegularChat()) {
                        if (exportButton) {
                            scheduleUiCheck();
                        }
                        return;
                    }

                    // Tant que le header n'est pas prêt,
                    // retenter l'insertion lors des mutations DOM.
                    if (!exportButton) {
                        scheduleUiCheck();
                        return;
                    }

                    // Après insertion, seul disabled nous intéresse
                    // pour synchroniser l'état avec Share.
                    if (
                        mutations.some(
                            mutation =>
                                mutation.type ===
                                    'attributes' &&
                                mutation.attributeName ===
                                    'disabled'
                        )
                    ) {
                        scheduleUiCheck();
                    }
                }
            );

        state.uiObserver.observe(
            document.body,
            {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: [
                    'disabled'
                ]
            }
        );

        scheduleUiCheck();

        debugLog(
            'UI observer started'
        );
    }

    function handleRouteChange() {
        document
            .getElementById(
                EXPORT_BUTTON_ID
            )
            ?.remove();

        state.labels = null;

        scheduleUiCheck();
        startKeepAliveWindow();

        debugLog(
            'Route change detected'
        );
    }

    function installHistoryHooks() {
        const originalPushState =
            history.pushState;

        const originalReplaceState =
            history.replaceState;

        history.pushState =
            function(...args) {
                const result =
                    originalPushState.apply(
                        this,
                        args
                    );

                handleRouteChange();

                return result;
            };

        history.replaceState =
            function(...args) {
                const result =
                    originalReplaceState.apply(
                        this,
                        args
                    );

                handleRouteChange();

                return result;
            };

        window.addEventListener(
            'popstate',
            handleRouteChange,
            { passive: true }
        );
    }

    // ============================================================
    // INITIALIZATION
    // ============================================================

    injectStyles();
    installHistoryHooks();
    startUiObserver();
    startKeepAliveWindow();

})();
