# Локальный клиент Пачки

Клиент использует обычный вход через сайт Пачки и протокол её веб-клиента. Персональный токен, доступ к публичному API и бот для этого не нужны. Сессия хранится в отдельном профиле Edge в `%LOCALAPPDATA%\PachcaWebClient\profile`.

## Пакет для коллег

Скачайте `Pachca-AI-win-portable-x64.exe` из [последнего релиза](https://github.com/babstovo/pachca_ai/releases/latest), сохраните EXE в постоянную папку и запустите его. Начиная с версии 0.3.0 клиент проверяет GitHub при запуске. Когда выйдет новая стабильная версия, в шапке появится кнопка «Доступно обновление».

`packaging/build-windows.ps1` собирает `dist/Pachca-AI-win-portable-x64.exe` со встроенными Node.js и локальным MCP. Для сборки нужны Node.js с npm, PowerShell и компилятор C# из .NET Framework. Кнопка «Подключить агента» в настройках клиента добавляет инструменты Пачки и OpenProject в пользовательские настройки для всех локальных проектов Codex. Подробности в [инструкции из пакета](packaging/README.md).

## Выпуск обновления

Для выпуска обновления увеличьте версию в `package.json` и `package-lock.json`, затем отправьте тег вида `v0.3.1` на соответствующий коммит. GitHub Actions соберёт Windows EXE, проверит его запуск и приложит к релизу.

## Вход

Нужны Windows, Microsoft Edge и Node.js 22 или новее. Из папки проекта в PowerShell запусти:

```powershell
npm.cmd ci --ignore-scripts
node .\pachca.mjs login
node .\pachca.mjs profiles
node .\pachca.mjs openproject-login
node .\pachca.mjs openproject-tasks
node .\pachca.mjs connect
```

Войди в открывшемся окне Пачки. Клиент закроет его, когда получит список пространств. Если сессия истекла, снова запусти `login`. При нескольких пространствах добавь `--profile ID` из вывода `profiles` к командам чтения и отправки.

Для подключения OpenProject в приложении откройте «Настройки агента» → «Доска задач» → «Настроить» и сохраните ссылку на свою доску и API-ключ. Подключение агента для этого необязательно.

## Чтение и отправка

```powershell
node .\pachca.mjs folders
node .\pachca.mjs chats 42
node .\pachca.mjs search chats 'Название чата'
node .\pachca.mjs search users 'Имя Фамилия'
node .\pachca.mjs search messages 'Текст сообщения'
node .\pachca.mjs history 123 --limit 10
node .\pachca.mjs message 456
node .\pachca.mjs thread 456
```

Портативный EXE открывает оригинальную Пачку внутри Microsoft Edge WebView2. Кнопка «Агент» раскрывает справа чат. В настройках агента синяя кнопка «Подключить агента» включает MCP Пачки для Codex и подключает помощника к открытому аккаунту. Красная кнопка отключает его. Журнал событий доступен из меню значка в трее. Крестик сворачивает окно в трей, а «Выход» в меню значка останавливает наблюдение.

В окне «Рассказать о себе» можно сохранить описание своей роли, стиль и правила общения. Настройки хранятся на компьютере отдельно для каждого профиля Пачки и учитываются при подготовке ответов.

```powershell
node .\pachca.mjs send chat 123 --file .\reply.txt
node .\pachca.mjs send user 789 --file .\reply.txt
node .\pachca.mjs send thread 456 --file .\reply.txt
```

Для треда передай ID родительского сообщения. Если треда ещё нет, `send thread` создаст его. `--quote MESSAGE_ID` добавляет цитату из целевого чата. `--file` читает UTF-8, также доступны `--text` и `--stdin`. Историю можно листать через `--before MESSAGE_ID`, папки и поиск через `--cursor` из ответа сервера. Список параметров выводится через `node .\pachca.mjs --help`.

Маршруты и формат запросов восстановлены по опубликованным модулям веб-версии `1.48.10`. Они могут измениться при обновлении Пачки. [Маршруты чтения](https://app.pachca.com/assets/query-options-D4dcqG5j.js), [отправка и треды](https://app.pachca.com/assets/main-CLNguRxR.js).
