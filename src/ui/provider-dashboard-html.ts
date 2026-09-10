export const providerDashboardHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ProviderDock</title>
  <link rel="stylesheet" href="app.css">
</head>
<body>
<aside class="app-sidebar">
  <a class="brand" href="#providers" data-nav="providers"><span class="brand-mark" aria-hidden="true">P</span><span>ProviderDock<small>Рабочее пространство</small></span></a>
  <span class="nav-label">Управление</span>
  <nav aria-label="Основная навигация">
    <button data-nav="providers" class="nav-item active" type="button"><span aria-hidden="true">▦</span>Провайдеры</button>
    <button data-nav="models" class="nav-item" type="button"><span aria-hidden="true">◈</span>Модели и цены</button>
    <button data-nav="routes" class="nav-item" type="button"><span aria-hidden="true">⇄</span>Маршруты и профили</button>
    <button data-nav="activity" class="nav-item" type="button"><span aria-hidden="true">≋</span>Активность</button>
    <button data-nav="settings" class="nav-item" type="button"><span aria-hidden="true">⚙</span>Ключи и настройки</button>
  </nav>
  <div class="sidebar-foot"><span class="dot on" aria-hidden="true"></span> Локальное приложение<small>Codex CLI · Claude Code</small></div>
</aside>
<main>
  <div class="page-head">
    <div><span class="eyebrow">ВАШЕ РАБОЧЕЕ ПРОСТРАНСТВО</span><h1 id="page-title">Провайдеры</h1><p id="page-description">Все подключения, кошельки и состояние API в одном месте.</p></div>
    <div class="head-state">
      <span id="connection-dot" class="dot" aria-hidden="true"></span>
      <span id="connection-text">Подключение…</span>
      <button id="refresh" class="link-button" type="button">Обновить</button>
    </div>
  </div>

  <div id="view-overview">
    <div class="stats" data-page="providers">
      <div class="stat"><span>Провайдеры</span><strong id="metric-providers">—</strong><small id="metric-provider-detail"></small></div>
      <div class="stat"><span>Модели</span><strong id="metric-models">—</strong><small id="metric-model-detail"></small></div>
      <div class="stat"><span>Задержка</span><strong id="metric-latency">—</strong><small>медиана проверок</small></div>
      <button id="open-usage-timeline" class="stat token-stat" type="button" aria-expanded="false" aria-controls="usage-history"><span>Токены <span aria-hidden="true">⌄</span></span><strong id="metric-tokens">—</strong><small id="metric-usage-detail"></small></button>

    <div id="usage-history" class="usage-timeline-panel" hidden>
      <div class="panel-head"><h2>Расход токенов</h2><span class="spacer"></span><label>Период<select id="usage-period"><option value="day">По дням</option><option value="week">По неделям</option></select></label><label>Дата<input id="usage-date" type="date"></label></div>
      <p class="hint padded">Время вашего браузера. Вход, выход, кэш и поиск — по запросам через ProviderDock. Текст задач не сохраняется.</p>
      <div id="usage-timeline" class="usage-timeline"></div><div id="usage-breakdown" class="item-list"></div>
    </div>
    </div>
    <section class="panel cost-panel" data-page="providers"><div class="panel-head"><h2>Стоимость токенов</h2><strong id="usage-cost-total">—</strong></div><p class="hint padded">Оценка по учтённым запросам и настроенным тарифам. Суммы в разных валютах считаются отдельно.</p><div id="usage-cost-breakdown" class="cost-breakdown"></div></section>
    <div class="workspace-grid">
      <section class="panel providers-panel" data-page="providers">
        <div class="panel-head">
          <h2>Провайдеры</h2>
          <span id="provider-count" class="count">0</span>
          <details class="help"><summary aria-label="Подсказка">?</summary><div class="help-body">«Проверить API» проверяет адрес, ключ и список моделей. «Тест L1» отправляет один минимальный запрос модели и может потратить несколько токенов.</div></details>
          <span class="spacer"></span>
          <div class="provider-head-actions"><button class="button" type="button" data-open-launch>▷ Запустить агента</button><button id="open-cookie-overview" class="button" type="button">Общий импорт</button><button id="add-provider" class="button primary" type="button">Добавить провайдера</button></div>
        </div>
        <div class="provider-filters"><label class="search-field">Найти провайдера<input id="provider-search" type="search" placeholder="Название, адрес или ID"></label><span class="hint">Откройте «Модели и цены» на карточке провайдера</span></div>
        <div id="providers" class="provider-list"></div>
      </section>

    </div>

    <section class="panel storefront-panel" data-page="models" hidden>
      <div class="panel-head">
        <h2>Витрина моделей</h2>
        <span id="model-count" class="count">0</span>
        <span class="spacer"></span>
        <div class="view-switch" aria-label="Вид витрины"><button data-model-view="cards" type="button" class="mini active" aria-pressed="true">Карточки</button><button data-model-view="table" type="button" class="mini" aria-pressed="false">Таблица</button></div>
      </div>
      <div class="storefront-controls catalog-toolbar">
        <label>Провайдер<select id="model-provider"><option value="">Все провайдеры</option></select></label>
        <label>Поиск<input id="model-search" type="search" placeholder="Название модели, провайдер или тег…"></label>
        <label>Тарифная группа<select id="model-group"><option value="">Базовые цены</option></select></label>
        <span class="unit-caption">Цены / 1M токенов</span>
      </div>
      <div id="storefront-scope" class="storefront-scope"></div>
      <p class="hint storefront-note">Валюта указана рядом с ценой. Коэффициент выбранной группы уже учтён.</p>
      <p id="model-results-note" class="hint storefront-note"></p>
      <div id="models" class="model-groups"></div>
      <div class="storefront-controls"><button id="models-prev" type="button" class="button">Назад</button><span id="model-page"></span><button id="models-next" type="button" class="button">Далее</button><span class="hint">По 50 моделей</span></div>
    </section>

    <section class="panel" data-page="routes" hidden>
      <div class="panel-head">
        <h2>Цепочки моделей</h2>
        <span id="chain-count" class="count">0</span>
        <span class="hint">автопереключение на резерв при сбое</span>
        <span class="spacer"></span>
        <button id="add-logical-model" class="button primary" type="button">Создать цепочку</button>
      </div>
      <div id="logical-models" class="chain-list"></div>
    </section>

    <div class="two-col" data-page="routes" hidden>
      <section class="panel">
        <div class="panel-head">
          <h2>Профили инструкций</h2>
          <span class="spacer"></span>
          <button id="add-prompt-profile" class="button" type="button">Создать профиль</button>
        </div>
        <div id="prompt-profiles" class="item-list"></div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>Привязки проектов</h2>
          <span class="spacer"></span>
          <button id="add-project-profile" class="button" type="button">Привязать проект</button>
        </div>
        <p class="hint padded">Привязка применяет профиль автоматически при запуске из папки проекта.</p>
        <div id="project-profiles" class="item-list"></div>
      </section>
    </div>

    <section class="panel" data-page="settings" hidden>
      <div class="panel-head">
        <h2>Ключи</h2>
        <small id="secret-vault-state" class="hint"></small>
        <span class="spacer"></span>
        <button id="add-secret" class="button" type="button">Сохранить ключ</button>
      </div>
      <div id="secrets" class="item-list"></div>
    </section>

    <section class="activity-dashboard" data-page="activity" hidden>
      <div class="activity-controls"><label>Провайдер<select id="activity-provider"><option value="">Все провайдеры</option></select></label><label>Период<select id="activity-range"><option value="7">7 дней</option><option value="30">30 дней</option></select></label></div>
      <div id="activity-metrics" class="stats"></div>
      <section class="panel activity-chart-panel"><div class="chart-tabs" role="tablist" aria-label="Графики активности"><button type="button" data-chart="tokens" class="active">Расход токенов</button><button type="button" data-chart="requests">Запросы</button><button type="button" data-chart="statuses">Состояния моделей</button><button type="button" data-chart="ranking">Использование моделей</button></div><div id="activity-chart" class="activity-chart"></div></section>
      <section class="panel"><div class="panel-head"><h2>Модели по провайдерам</h2><span class="hint">Наблюдения за 24 часа</span></div><div id="activity-provider-models"></div></section>
    </section>
    <div class="two-col activity-history" data-page="activity" hidden>
      <section class="panel">
        <div class="panel-head"><h2>Активность</h2></div>
        <div id="launches" class="item-list"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Использование</h2></div>
        <div id="usage" class="item-list"></div>
      </section>
    </div>
  </div>

</main>

<div id="provider-drawer-backdrop" class="drawer-backdrop" hidden></div>
<aside id="provider-drawer" class="provider-drawer" aria-hidden="true" aria-label="Профиль провайдера">
  <div class="drawer-head"><h2>Профиль провайдера</h2><button id="close-provider-drawer" class="icon-button" type="button" aria-label="Закрыть">×</button></div>
  <div id="provider-detail" class="drawer-body"></div>
</aside>

<div id="global-status" class="status-line" aria-live="polite"></div>
<dialog id="cookie-overview-dialog" aria-labelledby="cookie-overview-title"><div class="dialog-card wide cookie-overview-card">
<div class="dialog-head"><div><h2 id="cookie-overview-title">Общий импорт аккаунтов</h2><p class="hint">Все кабинеты в одном списке: способ подключения, доступные данные и ссылка для входа.</p></div><button type="button" class="icon-button" data-close-dialog="cookie-overview-dialog">×</button></div>
  <div class="dialog-body"><div id="cookie-overview-summary" class="cookie-overview-summary"></div><div id="cookie-overview-list" class="cookie-overview-list"></div></div>
  <div class="dialog-foot"><button type="button" class="button" data-close-dialog="cookie-overview-dialog">Закрыть</button></div>
</div></dialog>

<dialog id="cookie-import-dialog" aria-labelledby="cookie-import-title"><form id="cookie-import-form" method="dialog" class="dialog-card wide">
  <div class="dialog-head"><h2 id="cookie-import-title">Импорт аккаунта</h2><button type="button" class="icon-button" data-close-dialog="cookie-import-dialog">×</button></div>
  <div class="dialog-body">
    <p id="cookie-import-provider"></p>
    <label>Адрес сайта кабинета<input name="siteUrl" type="url" required placeholder="https://provider.example"><small>Секрет сохраняется только для выбранного провайдера и этого домена.</small></label>
    <label>Способ подключения<select name="authKind"><option value="cookie">Cookie-Editor</option><option value="bearer">Access Token</option></select></label>
    <label id="portal-import-user-id">ID аккаунта <span class="optional">только если сайт требует New-Api-User</span><input name="userId" type="number" min="1" step="1"></label>
    <label><span id="portal-import-raw-label">Экспорт Cookie-Editor</span><textarea name="raw" rows="10" required placeholder="В Cookie-Editor выберите Export → JSON и вставьте результат сюда"></textarea><small id="portal-import-raw-hint">Поддерживаются JSON, Header String и Netscape. Экспортируйте cookies текущего сайта, не всего браузера.</small></label>
    <div class="advanced-fields"><label>Платформа<select name="adapterId" required></select></label><label class="checkbox-label"><input name="autoRefresh" type="checkbox" checked> Автообновление каждые 5 минут</label></div>
    <input name="providerId" type="hidden">
    <div id="cookie-import-status" class="status-line" aria-live="polite"></div>
  </div>
  <div class="dialog-foot"><button type="button" class="button" data-close-dialog="cookie-import-dialog">Отмена</button><button class="button primary" type="submit">Сохранить и проверить</button></div>
</form></dialog>

<dialog id="launch-dialog" aria-labelledby="launch-dialog-title"><div class="dialog-card launch-dialog-card"><div class="dialog-head"><div><span class="eyebrow">РАБОЧАЯ СЕССИЯ</span><h2 id="launch-dialog-title">Запустить агента</h2></div><button type="button" class="icon-button" data-close-dialog="launch-dialog" aria-label="Закрыть">×</button></div>        <form class="dialog-body" id="launch-form" novalidate>
          <label>Папка проекта<span class="input-action"><input id="launch-project" name="projectDirectory" required readonly placeholder="Папка не выбрана"><button id="pick-launch-project" class="button" type="button">Выбрать папку</button></span></label>
          <label>Агент<select id="launch-client" name="client"><option value="auto">Авто</option><option value="codex">Codex CLI</option><option value="claude-code">Claude Code</option></select></label>
          <div class="field-label">Маршрут</div>
          <div class="route-tabs" id="route-tabs">
            <button type="button" class="route-tab active" data-route="provider">Модель</button>
            <button type="button" class="route-tab" data-route="logical-model">Цепочка</button>
            <button type="button" class="route-tab" data-route="prompt-profile">Инструкции</button>
            <button type="button" class="route-tab" data-route="project-profile">По проекту</button>
          </div>
          <div id="provider-route-fields" class="form-row route-fields">
            <label>Провайдер<select id="launch-provider" name="providerId"></select></label>
            <label>Модель<select id="launch-model" name="modelId"></select></label>
          </div>
          <label id="logical-route-field" class="route-fields" hidden>Цепочка<select id="launch-logical-model" name="logicalModelId"></select></label>
          <label id="prompt-route-field" class="route-fields" hidden>Профиль инструкций<select id="launch-prompt-profile" name="promptProfileId"></select></label>
          <p id="project-route-hint" class="hint route-fields" hidden>Настройки возьмутся из привязки выбранной папки.</p>
          <div id="binding-hint" class="hint accent" hidden></div>
          <div id="launch-preview" class="launch-preview" aria-live="polite"></div><button id="launch-submit" class="button primary launch-submit" type="submit">Запустить агента</button>
          <div id="launch-status" class="status-line" aria-live="polite"></div>
        </form></div></dialog>
<dialog id="provider-dialog"><div class="dialog-card settings-shell">
    <div class="dialog-head"><h2 id="provider-dialog-title">Настройки</h2><button id="close-provider-dialog" class="icon-button" type="button" aria-label="Закрыть">×</button></div>
    <div class="settings-tabs" role="tablist" aria-label="Настройки"><button id="settings-provider-tab" type="button" role="tab" aria-controls="provider-form" data-settings-tab="provider">Провайдер</button><button id="settings-account-tab" type="button" role="tab" aria-controls="portal-form" data-settings-tab="account">Кабинет</button></div>
  <form id="provider-form" method="dialog" class="settings-pane" role="tabpanel" aria-labelledby="settings-provider-tab">
    <div class="dialog-body">
      <label>Название провайдера<input name="displayName" placeholder="Например, Vessa LLM"><small>Ваше название, независимо от адреса API.</small></label>
      <div class="field-label">Способ настройки</div>
      <div class="route-tabs provider-setup-tabs" id="provider-setup-tabs">
        <button type="button" class="route-tab active" data-provider-setup="auto">URL или cURL</button>
        <button type="button" class="route-tab" data-provider-setup="simple">Base URL + API-ключ</button>
      </div>
      <div id="provider-auto-setup" class="provider-setup-pane">
        <label>URL API или пример cURL<textarea name="quickSetup" rows="4" required placeholder="https://provider.example/v1&#10;&#10;или пример cURL из документации провайдера"></textarea><small>Можно вставить обычный URL. cURL нужен только если хотите автоматически перенести модель и дополнительные заголовки.</small></label>
        <div class="quick-setup-actions"><button id="detect-provider" class="button" type="button">Определить настройки</button><span id="provider-detection-state">Ожидается URL API или пример cURL.</span></div>
        <div class="form-row"><label>API-ключ<input name="apiKey" type="password" autocomplete="new-password" placeholder="Не нужен для публичного API"><small id="provider-api-key-hint">Шифруется Windows и не записывается в профиль.</small></label></div>
        <label>Модели вручную <span class="optional">необязательно, по одной в строке</span><textarea name="manualModelIds" rows="2" placeholder="Можно оставить пустым — попробуем получить через API"></textarea></label>
      </div>
      <div id="provider-simple-setup" class="provider-setup-pane" hidden>
        <label>Base URL<input name="simpleBaseUrl" type="url" placeholder="https://provider.example/v1"><small>Можно также вставить полный endpoint, например /v1/chat/completions — базовый адрес определится сам.</small></label>
        <label>API-ключ<input name="simpleApiKey" type="password" autocomplete="new-password" placeholder="Не нужен для публичного API"><small>ID, тип API и способ авторизации настроятся автоматически.</small></label>
      </div>
      <fieldset id="provider-portal-inline" class="provider-portal-setup">
        <legend>Витрина и личный кабинет <span class="optional">необязательно</span></legend>
        <p class="hint">Модели, цены, баланс и ежедневный check-in на сайте провайдера.</p>
        <label>Адрес сайта<input name="portalSiteUrl" type="url" placeholder="https://seekai.cc"><small>Можно вставить ссылку на /pricing или /profile. Если указан токен, пустой адрес заполнится из Base URL.</small></label>
        <label>Способ входа в кабинет<select name="portalAuthKind"><option value="bearer">Токен кабинета</option><option value="cookie">Сессия браузера (Cookie)</option></select></label>
        <label>Токен или Cookie кабинета<input name="portalToken" type="password" autocomplete="new-password" placeholder="Access Token из профиля на сайте"><small>New API: Профиль → Безопасность → Токен доступа. Сохраняется отдельно от API-ключа модели. Пусто — сохранить прежний токен.</small></label>
        <details><summary>Платформа и ID аккаунта</summary><div class="advanced-fields"><label>Платформа<select name="portalAdapterId"></select></label><label>ID аккаунта (если сайт требует)<input name="portalUserId" type="number" min="1" step="1"></label></div></details>
      </fieldset>
      <details id="provider-advanced"><summary>Расширенные настройки</summary><div class="advanced-fields">
        <div class="form-row"><label>Системный ID<input name="id" pattern="[a-z0-9][a-z0-9_-]*" placeholder="my-provider"></label><label>Базовый URL<input name="baseUrl" type="url" placeholder="https://provider.example/v1"></label></div>
        <div class="form-row"><label>Тип API<select name="apiType"><option value="auto">Определять автоматически</option><option value="openai-responses">OpenAI Responses</option><option value="openai-chat-completions">Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option><option value="custom">Другой</option></select></label><label>Адаптер<select name="adapterId"><option value="auto">Автоматически</option><option value="generic-openai">Generic OpenAI</option><option value="generic-anthropic">Generic Anthropic</option><option value="agentrouter">AgentRouter</option><option value="gorouter">GoRouter</option><option value="custom">Другой</option></select></label></div>
        <div class="form-row"><label>Авторизация<select id="provider-auth-kind" name="authKind"><option value="none">Без авторизации</option><option value="bearer">Bearer-токен</option><option value="header">Секретный заголовок</option><option value="query">Секретный параметр URL</option></select></label><label id="provider-auth-name-field" hidden>Имя заголовка или параметра<input name="authName" placeholder="x-api-key"></label></div>
        <label id="provider-secret-ref-field" hidden>Ссылка на ключ<input name="secretRef" placeholder="PROVIDER_API_KEY"><small>Создаётся автоматически.</small></label>
        <div class="form-row"><label>Предпочитаемый агент<select name="preferredClient"><option value="auto">Автоматически</option><option value="codex">Codex CLI</option><option value="claude-code">Claude Code</option></select></label><label>Endpoint моделей<input name="modelsEndpoint" value="models"></label></div>
        <div class="form-row"><label>Тайм-аут (мс)<input name="timeoutMs" type="number" min="250" max="300000" value="120000"></label><label class="checkbox-label"><input name="enabled" type="checkbox" checked>Провайдер включён</label></div>
        <label>Постоянные заголовки<textarea name="staticHeaders" rows="2" placeholder="X-Client: ProviderDock"></textarea></label>
        <label>Секретные заголовки<textarea name="secretHeaders" rows="2" placeholder="x-api-key: PROVIDER_API_KEY"></textarea></label>
        <label>Параметры URL<textarea name="queryParameters" rows="2" placeholder="api-version: 2026-01-01"></textarea></label>
      </div></details>
    </div>
    <div id="provider-model-controls" class="settings-model-controls"></div>
    <div class="dialog-foot"><button id="cancel-provider" class="button" type="button">Отмена</button><button class="button primary" type="submit">Сохранить провайдера</button></div>
  </form>

  <form id="portal-form" method="dialog" class="settings-pane" role="tabpanel" aria-labelledby="settings-account-tab" hidden>
    <div class="dialog-body">
      <p id="portal-provider"></p><div class="portal-login-actions"><button id="portal-cookie-import" class="button primary" type="button">Импортировать Cookie Editor</button><a id="portal-site-login" class="link-button" target="_blank" rel="noopener noreferrer">Открыть сайт ↗</a></div><p id="portal-platform-note" class="hint"></p><input name="providerId" type="hidden">
      <label>Адрес сайта<input name="siteUrl" type="url" required placeholder="https://seekai.cc"><small>Адрес личного кабинета может отличаться от адреса API.</small></label>
      <label>Платформа<select name="adapterId" required></select></label>
      <label>Способ входа<select name="authKind"><option value="bearer">Токен кабинета</option><option value="cookie">Сессия браузера (Cookie)</option></select></label>
      <label>Токен или Cookie кабинета<input name="accountToken" type="password" autocomplete="new-password"><small>Отдельный токен аккаунта / access token, если сайт его предоставляет. Обычный ключ для моделей может не подходить. Пусто — сохранить текущий токен или читать только публичный статус.</small></label>
      <details class="portal-session-help"><summary>Ручное подключение сессии</summary><p>Если автоматический вход не поддерживается сайтом, в инструментах разработчика браузера → Network выберите запрос кабинета (например, user/self), скопируйте значение заголовка Cookie и вставьте в поле выше. Выберите «Сессия браузера». Если запрос содержит New-Api-User, укажите его значение в ID аккаунта.</p><p>Сессия хранится зашифрованной локально. Когда она истечёт, приложение предложит войти заново.</p></details>
      <details class="portal-token-help"><summary>Где взять токен кабинета?</summary>
        <p>На <a href="https://seekai.cc/profile" target="_blank" rel="noopener noreferrer">SeekAI откройте профиль</a>, прокрутите до блока «Безопасность» и нажмите «Токен доступа» (Access Token). В окне токена выберите «Перегенерировать», подтвердите действие на сайте и скопируйте показанный токен сюда.</p>
        <p>Токен показывается один раз. Перегенерация заменяет прежний токен: приложения, использующие его, потребуют обновления. Если прежний токен сохранён у вас, можно использовать его.</p>
        <p>На других сайтах название и расположение раздела могут отличаться. Токен вводится только в это локальное поле, отправлять его в чат не нужно.</p>
      </details>
      <label>Ссылка на сохранённый токен<input name="secretRef" autocomplete="off" placeholder="Создаётся при вводе токена"><small>При вводе нового токена можно оставить пустым — имя создастся автоматически. Токен хранится зашифрованным локально и не передаётся агентам.</small></label>
      <label>ID аккаунта (необязательно)<input name="userId" type="number" min="1" step="1"><small>Для версий сайта, которым нужен ID вместе с токеном. Также проверяет, что подключён нужный аккаунт.</small></label>
      <label><input name="autoRefresh" type="checkbox" checked> Автообновление каждые 5 минут</label>
      <p class="hint">Загружает витрину, цены, статистику сайта, кошелёк и статус ежедневного входа. Награда не забирается автоматически. Ограничения расходов пока не подключены.</p>
    </div>
    <div class="dialog-foot"><button id="disconnect-portal" class="button" type="button" hidden>Отключить кабинет</button><button data-close-dialog="provider-dialog" class="button" type="button">Отмена</button><button class="button primary" type="submit">Сохранить и проверить</button></div>
  </form>
</div></dialog>

<dialog id="logical-model-dialog">
  <form id="logical-model-form" method="dialog" class="dialog-card wide">
    <div class="dialog-head"><h2 id="logical-model-dialog-title">Создать цепочку</h2><button data-close-dialog="logical-model-dialog" class="icon-button" type="button" aria-label="Закрыть">×</button></div>
    <div class="dialog-body">
      <div class="form-row">
        <label>Название цепочки<input name="id" required pattern="[a-z0-9][a-z0-9_-]*" placeholder="coding"></label>
        <label>Добавить маршрут<span class="input-action"><select id="chain-provider"></select><select id="chain-model"></select><button id="chain-add" class="button" type="button">Добавить</button></span></label>
      </div>
      <div id="chain-routes" class="chain-editor"></div>
      <p class="hint">Порядок сверху вниз — порядок попыток. При сбое до начала ответа запрос переходит на следующий маршрут.</p>
    </div>
    <div class="dialog-foot"><button data-close-dialog="logical-model-dialog" class="button" type="button">Отмена</button><button class="button primary" type="submit">Сохранить цепочку</button></div>
  </form>
</dialog>

<dialog id="prompt-profile-dialog">
  <form id="prompt-profile-form" method="dialog" class="dialog-card">
    <div class="dialog-head"><h2 id="prompt-profile-dialog-title">Создать профиль</h2><button data-close-dialog="prompt-profile-dialog" class="icon-button" type="button" aria-label="Закрыть">×</button></div>
    <div class="dialog-body">
      <label>Название<input name="name" required placeholder="Практичная разработка"></label>
      <label>Инструкции агенту<textarea name="instructions" rows="6" required placeholder="Сначала изучи существующую реализацию. Вноси минимальные проверенные изменения."></textarea></label>
      <div class="field-label">Маршрут</div>
      <div class="route-tabs compact" id="prompt-route-tabs">
        <button type="button" class="route-tab active" data-proute="provider">Провайдер и модель</button>
        <button type="button" class="route-tab" data-proute="logical-model">Цепочка моделей</button>
      </div>
      <div id="prompt-provider-route" class="form-row route-fields"><label>Провайдер<select name="preferredProviderId"></select></label><label>Модель<input name="preferredModelId" placeholder="gpt-x"></label></div>
      <label id="prompt-logical-route" class="route-fields" hidden>Цепочка<select name="preferredLogicalModelId"></select></label>
      <div class="form-row"><label>Агент<select name="preferredClient"><option value="auto">Авто</option><option value="codex">Codex CLI</option><option value="claude-code">Claude Code</option></select></label><label>Уровень рассуждений<input name="reasoningLevel" placeholder="не задан"></label></div>
      <details><summary>Дополнительно</summary><div class="advanced-fields">
        <div class="form-row"><label>ID профиля<input name="id" required pattern="[a-z0-9][a-z0-9_-]*" placeholder="practical"></label><label>Описание<input name="description" placeholder="небольшое пояснение"></label></div>
        <label>Флаги Codex<textarea name="codexFlags" rows="2" placeholder="по одному флагу в строке"></textarea></label>
        <label>Флаги Claude Code<textarea name="claudeFlags" rows="2" placeholder="по одному флагу в строке"></textarea></label>
      </div></details>
    </div>
    <div class="dialog-foot"><button data-close-dialog="prompt-profile-dialog" class="button" type="button">Отмена</button><button class="button primary" type="submit">Сохранить профиль</button></div>
  </form>
</dialog>

<dialog id="project-profile-dialog">
  <form id="project-profile-form" method="dialog" class="dialog-card">
    <div class="dialog-head"><h2 id="project-profile-dialog-title">Привязать проект</h2><button data-close-dialog="project-profile-dialog" class="icon-button" type="button" aria-label="Закрыть">×</button></div>
    <div class="dialog-body">
      <label>Папка проекта<span class="input-action"><input name="projectDirectory" required placeholder="C:\\Projects\\example"><button id="pick-project-profile-dir" class="button" type="button">Выбрать…</button></span></label>
      <label>Профиль инструкций<select name="promptProfileId"></select></label>
    </div>
    <div class="dialog-foot"><button data-close-dialog="project-profile-dialog" class="button" type="button">Отмена</button><button class="button primary" type="submit">Сохранить привязку</button></div>
  </form>
</dialog>

<dialog id="secret-dialog">
  <form id="secret-form" method="dialog" class="dialog-card narrow">
    <div class="dialog-head"><h2>Сохранить API-ключ</h2><button data-close-dialog="secret-dialog" class="icon-button" type="button" aria-label="Закрыть">×</button></div>
    <div class="dialog-body">
      <label>Имя ссылки<input name="reference" required pattern="[A-Za-z0-9][A-Za-z0-9_.:-]*" placeholder="AGENTROUTER_API_KEY"></label>
      <label>API-ключ<input name="value" type="password" required autocomplete="new-password"><small>Шифруется Windows и никогда не возвращается через API.</small></label>
    </div>
    <div class="dialog-foot"><button data-close-dialog="secret-dialog" class="button" type="button">Отмена</button><button class="button primary" type="submit">Сохранить ключ</button></div>
  </form>
</dialog>

<dialog id="pricing-dialog">
  <form id="pricing-form" method="dialog" class="dialog-card narrow">
    <div class="dialog-head"><h2>Ручной тариф</h2><button data-close-dialog="pricing-dialog" class="icon-button" type="button" aria-label="Закрыть">×</button></div>
    <div class="dialog-body">
      <p id="pricing-model"></p><input name="providerId" type="hidden"><input name="modelId" type="hidden">
      <p class="hint">Для оценки расходов по новым запросам. Этот тариф сохраняется отдельно от цен витрины сайта и не ограничивает списания. После изменения перезапустите сессию агента.</p>
      <label>Валюта<input name="currency" required pattern="[A-Za-z]{3,4}" maxlength="4" value="USDT"></label>
      <label>Вход за 1 млн токенов<input name="inputPerMillion" type="number" min="0" max="1000000" step="any" required></label>
      <label>Выход за 1 млн токенов<input name="outputPerMillion" type="number" min="0" max="1000000" step="any" required></label>
      <label>Чтение кэша за 1 млн<input name="cacheReadInputPerMillion" type="number" min="0" max="1000000" step="any" placeholder="По цене входа"></label>
      <label>Запись кэша за 1 млн<input name="cacheWriteInputPerMillion" type="number" min="0" max="1000000" step="any" placeholder="По цене входа"></label>
      <label>Веб-поиск за 1000 запросов<input name="webSearchPerThousand" type="number" min="0" max="1000000" step="any" placeholder="Не задано"></label>
    </div>
    <div class="dialog-foot"><button data-close-dialog="pricing-dialog" class="button" type="button">Отмена</button><button class="button primary" type="submit">Сохранить</button></div>
  </form>
</dialog>
<dialog id="model-detail-dialog" class="model-detail-drawer" aria-labelledby="model-detail-title"><div class="dialog-card wide"><div class="dialog-head"><h2 id="model-detail-title">Модель</h2><button data-close-dialog="model-detail-dialog" class="icon-button" type="button" aria-label="Закрыть">×</button></div><div id="model-detail-body" class="dialog-body"></div><div class="dialog-foot"><button data-close-dialog="model-detail-dialog" class="button" type="button">Закрыть</button></div></div></dialog>
<script src="app.js" defer></script>
</body>
</html>`;
