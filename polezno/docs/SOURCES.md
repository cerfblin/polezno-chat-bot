# Источники и происхождение данных

Проверены 11 октября 2026. В data/knowledge.json восемь коротких пересказов без индивидуальных назначений и дозировок:

| ID | Первичный источник |
|---|---|
| nih-supplements | [NIH/NCCIH — Using Dietary Supplements Wisely](https://www.nccih.nih.gov/health/using-dietary-supplements-wisely/) |
| who-diet | [WHO — Healthy diet](https://www.who.int/en/news-room/fact-sheets/detail/healthy-diet) |
| ods-vitamin-d | [NIH ODS — Vitamin D](https://ods.od.nih.gov/factsheets/VitaminD-Consumer/) |
| ods-vitamin-c | [NIH ODS — Vitamin C](https://ods.od.nih.gov/factsheets/VitaminC-Consumer/) |
| ods-magnesium | [NIH ODS — Magnesium](https://ods.od.nih.gov/factsheets/Magnesium-Consumer/) |
| ods-iron | [NIH ODS — Iron](https://ods.od.nih.gov/factsheets/Iron-Consumer/) |
| ods-omega3 | [NIH ODS — Omega-3 Fatty Acids](https://ods.od.nih.gov/factsheets/Omega3FattyAcids-Consumer/) |
| ods-probiotics | [NIH ODS — Probiotics](https://ods.od.nih.gov/factsheets/Probiotics-Consumer/) |

Это открытая базовая справка, разрешённая владельцем; проверки врачом заказчика не было. clinicianReviewed=false. enabled=true означает доступность пересказа, не медицинское одобрение. Бот не ищет в интернете во время консультации.

Каталог data/catalog.json пуст. Владелец подтвердил, что магазин/Mini App появятся позднее. Чужие товары не выдаются за его ассортимент; импорт будет выполнен после появления подтверждённой выгрузки.

Документация реализации:

- [Telegram Bot API](https://core.telegram.org/bots/api): обновления, файлы, команды, области команд и описание профиля.
- [Node SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), [Node TypeScript](https://nodejs.org/docs/latest-v24.x/api/typescript.html).
- [OpenRouter — выбранная модель](https://openrouter.ai/apodex/apodex-1.1-mini:free), [каталог моделей](https://openrouter.ai/api/v1/models).
- [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection), [лимиты](https://openrouter.ai/docs/api_reference/limits), [политика данных](https://openrouter.ai/docs/guides/privacy/provider-logging).

Реальный бесплатный маршрут Apodex/Novita подтверждён синтетическими запросами с ограничениями цены и обработки данных. Для этой модели используется json_object и локальная проверка; заявленная поддержка structured_outputs в каталоге не подтвердилась для json_schema. Владелец выбрал только внешние модели; локальный ИИ не устанавливался.

Код написан отдельно. Исходники исследованных репозиториев не копировались; они использовались для сравнения подходов. Runtime-зависимостей npm нет. Dev dependencies — TypeScript и @types/node.
